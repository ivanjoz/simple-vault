import { describe, expect, test } from 'bun:test';

import { utf8ToBytes } from '../crypto/encoding.ts';
import { encodeCbor } from './cbor.ts';
import { decodeComponent, encodeComponent } from './componentCodec.ts';

describe('encrypted component codec', () => {
	test('round-trips marked CBOR', () => {
		const value = ['GitHub', 'octocat', 'hunter2', 'https://github.com', 'notes'];
		expect(decodeComponent(encodeComponent(value))).toEqual(value);
	});

	test('reads transitional unmarked CBOR', () => {
		const value = [['old password', 1_700_000_000]];
		expect(decodeComponent(encodeCbor(value))).toEqual(value);
	});

	test('reads transitional JSON arrays instead of treating 0x5b as a CBOR length', () => {
		const value = ['GitHub', 'octocat', 'hunter2', 'https://github.com', 'notes'];
		expect(decodeComponent(utf8ToBytes(JSON.stringify(value)))).toEqual(value);
	});
});
