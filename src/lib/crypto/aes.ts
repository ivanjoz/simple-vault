// AES-GCM-256 primitives over the WebCrypto API.

import type { Bytes, EncBlob } from './types.ts';
import { base64ToBytes, bytesToBase64 } from './encoding.ts';
import { randomBytes } from './random.ts';

const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/** Import raw key bytes (16/24/32) as an AES-GCM key. Non-extractable by default. */
export function importAesKey(raw: Bytes, extractable = false): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, [
		'encrypt',
		'decrypt'
	]);
}

/** Encrypt to the canonical binary form: 12-byte IV | ciphertext | 16-byte tag. */
export async function aesEncrypt(
	key: CryptoKey,
	plaintext: Bytes,
	aad?: Bytes
): Promise<Bytes> {
	const iv = randomBytes(IV_BYTES);
	const algorithm: AesGcmParams = { name: 'AES-GCM', iv };
	if (aad) algorithm.additionalData = aad;
	const ct = await crypto.subtle.encrypt(algorithm, key, plaintext);
	const encrypted = new Uint8Array(ct);
	const packed = new Uint8Array(iv.length + encrypted.length);
	packed.set(iv);
	packed.set(encrypted, iv.length);
	return packed;
}

/** Decrypt the canonical binary form emitted by {@link aesEncrypt}. */
export async function aesDecrypt(
	key: CryptoKey,
	packed: Bytes,
	aad?: Bytes
): Promise<Bytes> {
	assertEncryptedBytes(packed);
	const iv = packed.subarray(0, IV_BYTES) as Bytes;
	const algorithm: AesGcmParams = { name: 'AES-GCM', iv };
	if (aad) algorithm.additionalData = aad;
	const pt = await crypto.subtle.decrypt(algorithm, key, packed.subarray(IV_BYTES));
	return new Uint8Array(pt);
}

/** Convert a JSON-safe encrypted blob to its packed binary representation. */
export function encBlobToBytes(blob: EncBlob): Bytes {
	const iv = base64ToBytes(blob.iv);
	const encrypted = base64ToBytes(blob.data);
	if (iv.length !== IV_BYTES) throw new Error('invalid AES-GCM IV');
	if (encrypted.length < GCM_TAG_BYTES) throw new Error('invalid AES-GCM ciphertext');
	const packed = new Uint8Array(iv.length + encrypted.length);
	packed.set(iv);
	packed.set(encrypted, iv.length);
	return packed;
}

/** Convert packed bytes to the Base64 object used only by JSON persistence. */
export function bytesToEncBlob(packed: Bytes): EncBlob {
	assertEncryptedBytes(packed);
	return {
		iv: bytesToBase64(packed.subarray(0, IV_BYTES) as Bytes),
		data: bytesToBase64(packed.subarray(IV_BYTES) as Bytes)
	};
}

export function assertEncryptedBytes(packed: Bytes): void {
	if (packed.length < IV_BYTES + GCM_TAG_BYTES) throw new Error('invalid encrypted blob');
}
