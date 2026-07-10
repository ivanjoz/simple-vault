// Data Encryption Key (DEK) generation and wrapping (PLAN.md §3.1).
//
// The DEK is wrapped by simply AES-GCM-encrypting its raw bytes with a KEK —
// equivalent in strength to WebCrypto's wrapKey but simpler to reason about and
// test. Raw DEK bytes exist only transiently during create/unlock/rotate and are
// zeroed immediately after use.

import type { Bytes, EncBlob } from './types.ts';
import { aesDecrypt, aesEncrypt, importAesKey } from './aes.ts';
import { randomBytes } from './random.ts';

const DEK_BYTES = 32;

export function generateDekBytes(): Bytes {
	return randomBytes(DEK_BYTES);
}

/** Import DEK bytes as an AES-GCM key for record encryption. Non-extractable by default. */
export function importDek(dekBytes: Bytes, extractable = false): Promise<CryptoKey> {
	return importAesKey(dekBytes, extractable);
}

export function wrapDek(dekBytes: Bytes, kek: CryptoKey): Promise<EncBlob> {
	return aesEncrypt(kek, dekBytes);
}

/** Unwrap the DEK. Throws if the KEK is wrong (GCM authentication failure). */
export function unwrapDek(wrapped: EncBlob, kek: CryptoKey): Promise<Bytes> {
	return aesDecrypt(kek, wrapped);
}
