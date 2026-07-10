// AES-GCM-256 primitives over the WebCrypto API.

import type { Bytes, EncBlob } from './types.ts';
import { base64ToBytes, bytesToBase64 } from './encoding.ts';
import { randomBytes } from './random.ts';

const IV_BYTES = 12;

/** Import raw key bytes (16/24/32) as an AES-GCM key. Non-extractable by default. */
export function importAesKey(raw: Bytes, extractable = false): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, [
		'encrypt',
		'decrypt'
	]);
}

export async function aesEncrypt(key: CryptoKey, plaintext: Bytes): Promise<EncBlob> {
	const iv = randomBytes(IV_BYTES);
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
	return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ct)) };
}

/** Decrypt an {@link EncBlob}. Throws if authentication fails (wrong key / tampering). */
export async function aesDecrypt(key: CryptoKey, blob: EncBlob): Promise<Bytes> {
	const iv = base64ToBytes(blob.iv);
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(blob.data));
	return new Uint8Array(pt);
}
