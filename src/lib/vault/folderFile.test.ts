import { describe, expect, test } from 'bun:test';

import type { Bytes } from '$lib/crypto';
import { decodeFolderFile, decodeId, encodeFolderFile, encodeId } from './folderFile.ts';
import type { Folder, StoredRecord } from './types.ts';

function encryptedBytes(seed: number): Bytes {
	return new Uint8Array(36).fill(seed) as Bytes;
}

describe('CBOR v2 folder file', () => {
	test('stores an eight-character Base32 id in five bytes', () => {
		const encoded = encodeId('jtfano2b');
		expect(encoded.length).toBe(5);
		expect(decodeId(encoded)).toBe('jtfano2b');
	});

	test('round-trips folder, records, tombstones and independent history', () => {
		const folder: Folder = {
			id: 'jtfano2a',
			name: 'not persisted',
			updated: 1_700_000_000,
			status: 'active',
			enc_name: encryptedBytes(1)
		};
		const records: StoredRecord[] = [
			{
				id: 'jtfano2b',
				folderId: folder.id,
				updated: 1_700_000_001,
				status: 'active',
				enc_data: encryptedBytes(2),
				enc_history: encryptedBytes(3),
				historyUpdated: 1_700_000_002
			},
			{
				id: 'jtfano2c',
				folderId: folder.id,
				updated: 1_700_000_003,
				status: 'deleted'
			}
		];

		const decoded = decodeFolderFile(encodeFolderFile(folder, records));
		expect(decoded.folder).toEqual({ ...folder, name: '' });
		expect(decoded.records).toEqual(records);
	});

	test('rejects truncation and trailing bytes', () => {
		const folder: Folder = {
			id: '00000000',
			name: '',
			updated: 1,
			status: 'active',
			enc_name: encryptedBytes(1)
		};
		const encoded = encodeFolderFile(folder, []);
		expect(() => decodeFolderFile(encoded.slice(0, -1))).toThrow('CBOR');
		const trailing = new Uint8Array(encoded.length + 1);
		trailing.set(encoded);
		expect(() => decodeFolderFile(trailing)).toThrow('CBOR');
	});
});
