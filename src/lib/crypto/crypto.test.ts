import { describe, expect, test } from 'bun:test';

import { aesDecrypt, aesEncrypt, importAesKey } from './aes.ts';
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from './encoding.ts';
import { generateDekBytes, importDek, unwrapDek, wrapDek } from './dek.ts';
import { deriveKekBytes } from './kdf.ts';
import { generateRecoveryKey, normalizeRecoveryKey, randomBytes } from './random.ts';
import {
	createVault,
	decryptJson,
	decryptRecoveryKey,
	encryptJson,
	unlockWithPassword,
	unlockWithRecovery
} from './envelope.ts';

// A fast KDF profile so the suite runs quickly. Real vaults use DEFAULT_KDF.
const FAST_KDF = { algo: 'argon2id', mem: 1024, iters: 1, parallelism: 1, hashLength: 32 } as const;

describe('encoding', () => {
	test('base64 round-trips arbitrary bytes', () => {
		const bytes = randomBytes(64);
		expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
	});

	test('utf8 round-trips unicode', () => {
		const text = 'pässwörd 🔐 中文';
		expect(bytesToUtf8(utf8ToBytes(text))).toBe(text);
	});
});

describe('recovery key', () => {
	test('is formatted as 4 groups of 4 Crockford chars', () => {
		const key = generateRecoveryKey();
		expect(key).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}(-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}){3}$/);
	});

	test('generates distinct keys', () => {
		expect(generateRecoveryKey()).not.toBe(generateRecoveryKey());
	});

	test('normalization folds ambiguous chars and separators', () => {
		// I->1, L->1, O->0, U->V per Crockford.
		expect(normalizeRecoveryKey('ilou-ILOU')).toBe('110V110V');
		expect(normalizeRecoveryKey('a3f9 k72m')).toBe('A3F9K72M');
	});
});

describe('aes-gcm', () => {
	test('round-trips a payload', async () => {
		const key = await importAesKey(randomBytes(32));
		const blob = await aesEncrypt(key, utf8ToBytes('secret'));
		expect(bytesToUtf8(await aesDecrypt(key, blob))).toBe('secret');
	});

	test('authenticates additional data', async () => {
		const key = await importAesKey(randomBytes(32));
		const aad = utf8ToBytes('record:a:1');
		const blob = await aesEncrypt(key, utf8ToBytes('secret'), aad);
		expect(bytesToUtf8(await aesDecrypt(key, blob, aad))).toBe('secret');
		await expect(aesDecrypt(key, blob, utf8ToBytes('record:b:1'))).rejects.toThrow();
	});

	test('fails to decrypt with the wrong key', async () => {
		const key = await importAesKey(randomBytes(32));
		const wrong = await importAesKey(randomBytes(32));
		const blob = await aesEncrypt(key, utf8ToBytes('secret'));
		await expect(aesDecrypt(wrong, blob)).rejects.toThrow();
	});
});

describe('kdf', () => {
	test('is deterministic for the same secret + salt', async () => {
		const salt = randomBytes(16);
		const a = await deriveKekBytes('pw', salt, FAST_KDF);
		const b = await deriveKekBytes('pw', salt, FAST_KDF);
		expect(a).toEqual(b);
	});

	test('differs with a different salt', async () => {
		const a = await deriveKekBytes('pw', randomBytes(16), FAST_KDF);
		const b = await deriveKekBytes('pw', randomBytes(16), FAST_KDF);
		expect(a).not.toEqual(b);
	});
});

describe('dek wrap/unwrap', () => {
	test('round-trips the DEK', async () => {
		const kek = await importAesKey(randomBytes(32));
		const dekBytes = generateDekBytes();
		const unwrapped = await unwrapDek(await wrapDek(dekBytes, kek), kek);
		expect(unwrapped).toEqual(dekBytes);
	});
});

describe('vault header', () => {
	test('unlocks with the master password', async () => {
		const { header } = await createVault('correct horse', { now: 1000, kdf: FAST_KDF });
		expect(header.format).toBe(2);
		await expect(unlockWithPassword(header, 'correct horse')).resolves.toBeDefined();
	});

	test('rejects the wrong master password', async () => {
		const { header } = await createVault('correct horse', { now: 1000, kdf: FAST_KDF });
		await expect(unlockWithPassword(header, 'wrong')).rejects.toThrow();
	});

	test('unlocks with the recovery key (any casing/spacing)', async () => {
		const { header, recoveryKey } = await createVault('pw', { now: 1000, kdf: FAST_KDF });
		const messy = recoveryKey.toLowerCase().replace(/-/g, ' ');
		await expect(unlockWithRecovery(header, messy)).resolves.toBeDefined();
	});

	test('the DEK from password and recovery unlock are interchangeable', async () => {
		const { header, recoveryKey } = await createVault('pw', { now: 1000, kdf: FAST_KDF });
		const dekPw = await unlockWithPassword(header, 'pw');
		const dekRec = await unlockWithRecovery(header, recoveryKey);
		const blob = await encryptJson(dekPw, { hello: 'world' });
		expect(await decryptJson(dekRec, blob)).toEqual({ hello: 'world' });
	});

	test('stores a decryptable convenience copy of the recovery key', async () => {
		const { header, recoveryKey } = await createVault('pw', { now: 1000, kdf: FAST_KDF });
		const dek = await unlockWithPassword(header, 'pw');
		expect(await decryptRecoveryKey(header, dek)).toBe(recoveryKey);
	});

	test('record field JSON round-trips through the DEK', async () => {
		const { header } = await createVault('pw', { now: 1000, kdf: FAST_KDF });
		const dek = await unlockWithPassword(header, 'pw');
		const secret = { password: 'hunter2', notes: 'n', history: [{ p: 'old', u: 5 }] };
		expect(await decryptJson(dek, await encryptJson(dek, secret))).toEqual(secret);
	});
});
