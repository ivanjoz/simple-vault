import { describe, expect, test } from 'bun:test';

import { bytesToBase64 } from '$lib/crypto';
import type { Bytes } from '$lib/crypto';
import type { Folder } from './types.ts';
import type { VaultHeader } from '$lib/crypto';
import { encodeFolderFile } from './folderFile.ts';
import { decodeBackup, encodeBackup } from './backup.ts';

const headerBlob = {
	iv: bytesToBase64(new Uint8Array(12)),
	data: bytesToBase64(new Uint8Array(16))
};
const encryptedBytes = new Uint8Array(28) as Bytes;

const header: VaultHeader = {
	format: 2,
	kdf: { algo: 'argon2id', mem: 1, iters: 1, parallelism: 1, hashLength: 32 },
	saltPassword: '',
	saltRecovery: '',
	wrappedDEK_password: headerBlob,
	wrappedDEK_recovery: headerBlob,
	enc_recoveryKey: headerBlob,
	updated: 1
};

describe('CBOR v2 backup', () => {
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
});
