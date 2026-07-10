// Argon2id key derivation (PLAN.md §3.2), via hash-wasm.

import { argon2id } from 'hash-wasm';
import type { Bytes, KdfParams } from './types.ts';
import { importAesKey } from './aes.ts';

export const DEFAULT_KDF: KdfParams = {
	algo: 'argon2id',
	mem: 65536, // 64 MiB
	iters: 3,
	parallelism: 1,
	hashLength: 32
};

/** Derive raw key-encryption-key bytes from a secret + salt. */
export async function deriveKekBytes(
	secret: string,
	salt: Bytes,
	params: KdfParams = DEFAULT_KDF
): Promise<Bytes> {
	const derived = await argon2id({
		password: secret,
		salt,
		parallelism: params.parallelism,
		iterations: params.iters,
		memorySize: params.mem,
		hashLength: params.hashLength,
		outputType: 'binary'
	});
	// Copy into a guaranteed ArrayBuffer-backed array (hash-wasm returns a plain Uint8Array).
	const bytes = new Uint8Array(derived.length);
	bytes.set(derived);
	return bytes;
}

/** Derive a non-extractable AES-GCM KEK from a secret + salt. */
export async function deriveKek(
	secret: string,
	salt: Bytes,
	params: KdfParams = DEFAULT_KDF
): Promise<CryptoKey> {
	const bytes = await deriveKekBytes(secret, salt, params);
	const key = await importAesKey(bytes);
	bytes.fill(0);
	return key;
}
