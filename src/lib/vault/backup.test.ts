import { describe, expect, test } from 'bun:test';

import { bytesToBase64 } from '$lib/crypto';
import type { Bytes } from '$lib/crypto';
import type { Folder, StoredRecord } from './types.ts';
import type { VaultHeader } from '$lib/crypto';
import { encodeFolderFile } from './folderFile.ts';
import { decodeBackup, encodeBackup, inspectBackup } from './backup.ts';
import { HEADER_FORMAT } from './format.ts';

const headerBlob = {
	iv: bytesToBase64(new Uint8Array(12)),
	data: bytesToBase64(new Uint8Array(16))
};
const encryptedBytes = new Uint8Array(28) as Bytes;

const header: VaultHeader = {
	format: HEADER_FORMAT,
	kdf: { algo: 'argon2id', mem: 1, iters: 1, parallelism: 1, hashLength: 32 },
	saltPassword: '',
	saltRecovery: '',
	wrappedDEK_password: headerBlob,
	wrappedDEK_recovery: headerBlob,
	enc_recoveryKey: headerBlob,
	updated: 1
};

describe('current CBOR backup', () => {
	test('round-trips a header and raw folder files', () => {
		const folder: Folder = {
			id: '00000000',
			name: '',
			updated: 1,
			status: 'active',
			enc_name: encryptedBytes
		};
		const folderBytes = encodeFolderFile(folder, []);
		const decoded = decodeBackup(encodeBackup(header, [folderBytes]));
		expect(decoded.header).toEqual(header);
		expect(decoded.folders).toEqual([folderBytes]);
	});

	test('rejects duplicate folders and trailing data', () => {
		const folder: Folder = {
			id: '00000000', name: '', updated: 1, status: 'active', enc_name: encryptedBytes
		};
		const bytes = encodeFolderFile(folder, []);
		expect(() => decodeBackup(encodeBackup(header, [bytes, bytes]))).toThrow('duplicate');
		const valid = encodeBackup(header, []);
		const trailing = new Uint8Array(valid.length + 1);
		trailing.set(valid);
		expect(() => decodeBackup(trailing)).toThrow('CBOR');
	});

	test('rejects duplicate record ids across different folders', () => {
		const first: Folder = {
			id: '00000000', name: '', updated: 1, status: 'active', enc_name: encryptedBytes
		};
		const second: Folder = {
			id: '00000001', name: '', updated: 1, status: 'active', enc_name: encryptedBytes
		};
		const record = {
			id: '00000002', updated: 2, status: 'active' as const, enc_data: encryptedBytes
		};
		expect(() =>
			decodeBackup(
				encodeBackup(header, [
					encodeFolderFile(first, [{ ...record, folderId: first.id }]),
					encodeFolderFile(second, [{ ...record, folderId: second.id }])
				])
			)
		).toThrow('duplicate backup record');
	});

	test('inspects only public structure without decrypting names or record fields', () => {
		const folder: Folder = {
			id: '00000000',
			name: 'not serialized in plaintext',
			updated: 10,
			status: 'active',
			enc_name: encryptedBytes
		};
		const records: StoredRecord[] = [
			{
				id: '00000001',
				folderId: folder.id,
				updated: 11,
				status: 'active',
				enc_data: encryptedBytes
			},
			{ id: '00000002', folderId: folder.id, updated: 12, status: 'deleted' }
		];
		const manifest = inspectBackup(encodeBackup(header, [encodeFolderFile(folder, records)]));
		expect(manifest).toMatchObject({
			format: 3,
			headerUpdated: 1,
			folderCount: 0,
			activeFolderCount: 0,
			itemCount: 2,
			activeItemCount: 1
		});
		expect(manifest.folders[0]).toEqual({
			id: '00000000',
			updated: 10,
			status: 'active',
			items: [
				{ id: '00000001', updated: 11, status: 'active', hasHistory: false },
				{ id: '00000002', updated: 12, status: 'deleted', hasHistory: false }
			]
		});
	});
});
