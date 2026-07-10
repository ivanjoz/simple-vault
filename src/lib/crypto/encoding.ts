// Byte <-> string helpers. Kept dependency-free (btoa/atob + TextEncoder are
// available in browsers, Web Workers, and Bun).

import type { Bytes } from './types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8ToBytes(text: string): Bytes {
	return encoder.encode(text) as Bytes;
}

export function bytesToUtf8(bytes: Bytes): string {
	return decoder.decode(bytes);
}

export function bytesToBase64(bytes: Bytes): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Bytes {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}
