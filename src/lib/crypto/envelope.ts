// High-level vault operations built on the crypto primitives (PLAN.md §3).

import type { Bytes, EncBlob, KdfParams, VaultHeader } from './types.ts';
import { aesDecrypt, aesEncrypt, bytesToEncBlob, encBlobToBytes } from './aes.ts';
import { generateDekBytes, importDek, unwrapDek, wrapDek } from './dek.ts';
import { base64ToBytes, bytesToUtf8, utf8ToBytes } from './encoding.ts';
import { DEFAULT_KDF, deriveKek } from './kdf.ts';
import { generateRecoveryKey, normalizeRecoveryKey, randomBytes } from './random.ts';
import { bytesToBase64 } from './encoding.ts';

export type UnlockMethod = 'password' | 'recovery';

const SALT_BYTES = 16;

export interface CreatedVault {
	header: VaultHeader;
	/** Shown once to the user for download; never persisted in plaintext. */
	recoveryKey: string;
	/** Session key for record encryption. */
	dek: CryptoKey;
	/** Raw DEK bytes — the worker retains these to support key re-wrapping. */
	dekBytes: Bytes;
}

export interface CreateVaultOptions {
	/** Header timestamp in whole Unix seconds. */
	now?: number;
	kdf?: KdfParams;
}

/** Create a brand-new vault. See PLAN.md §3.3 / §3.5. */
export async function createVault(
	masterPassword: string,
	options: CreateVaultOptions = {}
): Promise<CreatedVault> {
	const { now = Math.floor(Date.now() / 1000), kdf = DEFAULT_KDF } = options;
	const dekBytes = generateDekBytes();
	const recoveryKey = generateRecoveryKey();
	const saltPassword = randomBytes(SALT_BYTES);
	const saltRecovery = randomBytes(SALT_BYTES);

	const kekPassword = await deriveKek(masterPassword, saltPassword, kdf);
	const kekRecovery = await deriveKek(normalizeRecoveryKey(recoveryKey), saltRecovery, kdf);
	const dek = await importDek(dekBytes);

	const header: VaultHeader = {
		format: 2,
		kdf,
		saltPassword: bytesToBase64(saltPassword),
		saltRecovery: bytesToBase64(saltRecovery),
		wrappedDEK_password: bytesToEncBlob(await wrapDek(dekBytes, kekPassword)),
		wrappedDEK_recovery: bytesToEncBlob(await wrapDek(dekBytes, kekRecovery)),
		enc_recoveryKey: await encryptJson(dek, recoveryKey),
		updated: now
	};

	return { header, recoveryKey, dek, dekBytes };
}

/** Unwrap the raw DEK bytes using the master password or the recovery key. */
export async function unlockDekBytes(
	header: VaultHeader,
	secret: string,
	method: UnlockMethod
): Promise<Bytes> {
	const isPassword = method === 'password';
	const salt = base64ToBytes(isPassword ? header.saltPassword : header.saltRecovery);
	const wrapped = isPassword ? header.wrappedDEK_password : header.wrappedDEK_recovery;
	const normalized = isPassword ? secret : normalizeRecoveryKey(secret);
	const kek = await deriveKek(normalized, salt, header.kdf);
	return unwrapDek(encBlobToBytes(wrapped), kek); // throws on wrong secret
}

/** Unlock with the master password. Throws on wrong password. */
export async function unlockWithPassword(
	header: VaultHeader,
	masterPassword: string
): Promise<CryptoKey> {
	return toDek(await unlockDekBytes(header, masterPassword, 'password'));
}

/** Unlock with the recovery key. Throws on wrong key. */
export async function unlockWithRecovery(
	header: VaultHeader,
	recoveryKey: string
): Promise<CryptoKey> {
	return toDek(await unlockDekBytes(header, recoveryKey, 'recovery'));
}

/** Decrypt the convenience copy of the recovery key (needs an unlocked DEK). */
export async function decryptRecoveryKey(
	header: VaultHeader,
	dek: CryptoKey
): Promise<string> {
	return decryptJson<string>(dek, header.enc_recoveryKey);
}

/** Encrypt an arbitrary JSON-serialisable value with the DEK. */
export async function encryptJson(dek: CryptoKey, value: unknown, aad?: Bytes): Promise<EncBlob> {
	return bytesToEncBlob(await aesEncrypt(dek, utf8ToBytes(JSON.stringify(value)), aad));
}

/** Decrypt an {@link EncBlob} produced by {@link encryptJson}. */
export async function decryptJson<T>(dek: CryptoKey, blob: EncBlob, aad?: Bytes): Promise<T> {
	return JSON.parse(bytesToUtf8(await aesDecrypt(dek, encBlobToBytes(blob), aad))) as T;
}

async function toDek(dekBytes: Bytes): Promise<CryptoKey> {
	const dek = await importDek(dekBytes);
	dekBytes.fill(0);
	return dek;
}
