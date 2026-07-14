import { Decoder, Encoder } from 'cbor-x';
import type { Bytes } from '$lib/crypto';

// Folder and backup schemas use positional arrays, so record extensions and
// shared structure tables would add format state without providing a benefit.
const encoder = new Encoder({
	useRecords: false,
	structuredClone: false,
	tagUint8Array: false
});

const decoder = new Decoder({
	useRecords: false,
	copyBuffers: true
});

export function encodeCbor(value: unknown): Bytes {
	return new Uint8Array(encoder.encode(value)) as Bytes;
}

export function decodeCbor(bytes: Bytes): unknown {
	return decoder.decode(bytes);
}
