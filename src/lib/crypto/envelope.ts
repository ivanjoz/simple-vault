// High-level vault operations built on the crypto primitives (PLAN.md §3).

import type { Bytes, EncBlob, KdfParams, VaultEnvelope } from './types.ts';
import { aesDecrypt, aesEncrypt } from './aes.ts';
import { generateDekBytes, importDek, unwrapDek, wrapDek } from './dek.ts';
import { base64ToBytes, bytesToUtf8, utf8ToBytes } from './encoding.ts';
import { DEFAULT_KDF, deriveKek } from './kdf.ts';
import { generateRecoveryKey, normalizeRecoveryKey, randomBytes } from './random.ts';
import { bytesToBase64 } from './encoding.ts';

export type UnlockMethod = 'password' | 'recovery';

const SALT_BYTES = 16;

export interface CreatedVault {
	envelope: VaultEnvelope;
	/** Shown once to the user for download; never persisted in plaintext. */
	recoveryKey: string;
	/** Session key for record encryption. */
	dek: CryptoKey;
	/** Raw DEK bytes — the worker retains these to support key re-wrapping. */
	dekBytes: Bytes;
}

export interface CreateVaultOptions {
	/** Initial decrypted payload stored in `ciphertext` (defaults to an empty array). */
	initialData?: unknown;
	now?: number;
	kdf?: KdfParams;
}

/** Create a brand-new vault. See PLAN.md §3.3 / §3.5. */
export async function createVault(
	masterPassword: string,
	options: CreateVaultOptions = {}
): Promise<CreatedVault> {
	const { initialData = [], now = Date.now(), kdf = DEFAULT_KDF } = options;
	const dekBytes = generateDekBytes();
	const recoveryKey = generateRecoveryKey();
	const saltPassword = randomBytes(SALT_BYTES);
	const saltRecovery = randomBytes(SALT_BYTES);

	const kekPassword = await deriveKek(masterPassword, saltPassword, kdf);
	const kekRecovery = await deriveKek(normalizeRecoveryKey(recoveryKey), saltRecovery, kdf);
	const dek = await importDek(dekBytes);

	const envelope: VaultEnvelope = {
		version: 1,
		kdf,
		saltPassword: bytesToBase64(saltPassword),
		saltRecovery: bytesToBase64(saltRecovery),
		ciphertext: await encryptJson(dek, initialData),
		wrappedDEK_password: await wrapDek(dekBytes, kekPassword),
		wrappedDEK_recovery: await wrapDek(dekBytes, kekRecovery),
		enc_recoveryKey: await encryptJson(dek, recoveryKey),
		updated: now
	};

	return { envelope, recoveryKey, dek, dekBytes };
}

/** Unwrap the raw DEK bytes using the master password or the recovery key. */
export async function unlockDekBytes(
	envelope: VaultEnvelope,
	secret: string,
	method: UnlockMethod
): Promise<Bytes> {
	const isPassword = method === 'password';
	const salt = base64ToBytes(isPassword ? envelope.saltPassword : envelope.saltRecovery);
	const wrapped = isPassword ? envelope.wrappedDEK_password : envelope.wrappedDEK_recovery;
	const normalized = isPassword ? secret : normalizeRecoveryKey(secret);
	const kek = await deriveKek(normalized, salt, envelope.kdf);
	return unwrapDek(wrapped, kek); // throws on wrong secret (GCM auth failure)
}

/** Unlock with the master password. Throws on wrong password. */
export async function unlockWithPassword(
	envelope: VaultEnvelope,
	masterPassword: string
): Promise<CryptoKey> {
	return toDek(await unlockDekBytes(envelope, masterPassword, 'password'));
}

/** Unlock with the recovery key. Throws on wrong key. */
export async function unlockWithRecovery(
	envelope: VaultEnvelope,
	recoveryKey: string
): Promise<CryptoKey> {
	return toDek(await unlockDekBytes(envelope, recoveryKey, 'recovery'));
}

/** Decrypt the convenience copy of the recovery key (needs an unlocked DEK). */
export async function decryptRecoveryKey(
	envelope: VaultEnvelope,
	dek: CryptoKey
): Promise<string> {
	return decryptJson<string>(dek, envelope.enc_recoveryKey);
}

/** Encrypt an arbitrary JSON-serialisable value with the DEK. */
export async function encryptJson(dek: CryptoKey, value: unknown): Promise<EncBlob> {
	return aesEncrypt(dek, utf8ToBytes(JSON.stringify(value)));
}

/** Decrypt an {@link EncBlob} produced by {@link encryptJson}. */
export async function decryptJson<T>(dek: CryptoKey, blob: EncBlob): Promise<T> {
	return JSON.parse(bytesToUtf8(await aesDecrypt(dek, blob))) as T;
}

async function toDek(dekBytes: Bytes): Promise<CryptoKey> {
	const dek = await importDek(dekBytes);
	dekBytes.fill(0);
	return dek;
}
