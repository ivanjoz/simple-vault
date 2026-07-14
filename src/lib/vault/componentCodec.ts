// Codec for plaintext components immediately before/after AES-GCM. The marker
// keeps future serialization changes explicit without adding field names.

import { bytesToUtf8 } from '$lib/crypto';
import type { Bytes } from '$lib/crypto';
import { decodeCbor, encodeCbor } from './cbor.ts';

const CBOR_COMPONENT = 2;

export function encodeComponent(value: unknown): Bytes {
	const payload = encodeCbor(value);
	const encoded = new Uint8Array(payload.length + 1);
	encoded[0] = CBOR_COMPONENT;
	encoded.set(payload, 1);
	return encoded as Bytes;
}

export function decodeComponent(bytes: Bytes): unknown {
	if (bytes.length === 0) throw new Error('empty encrypted component');

	if (bytes[0] === CBOR_COMPONENT) {
		if (bytes.length === 1) throw new Error('empty CBOR component');
		return decodeCbor(bytes.subarray(1) as Bytes);
	}

	// Transitional v2 builds encrypted JSON positional arrays. An opening '['
	// is byte 0x5b, which cbor-x interprets as a uint64 byte-string length and
	// reports as an impossible >4 GiB allocation. Accept those payloads so an
	// existing pre-alpha vault can be opened and rewritten naturally on edit.
	if (firstNonWhitespace(bytes) === 0x5b) {
		return JSON.parse(bytesToUtf8(bytes)) as unknown;
	}

	// Also accept unmarked CBOR emitted before the component marker was added.
	return decodeCbor(bytes);
}

function firstNonWhitespace(bytes: Bytes): number | undefined {
	for (const byte of bytes) {
		if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return byte;
	}
	return undefined;
}
