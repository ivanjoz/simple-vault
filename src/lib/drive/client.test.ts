import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
	backupFileName,
	BACKUP_FILE_PREFIX,
	createBinaryFile,
	deleteFile,
	downloadBytes,
	downloadJson,
	findHeaderFile,
	folderFileName,
	folderIdFromFileName,
	HEADER_FILE_NAME,
	isBackupFileName,
	listBackupFiles,
	listVaultFiles,
	updateBinaryFile
} from './client.ts';
import { HEADER_FORMAT } from '$lib/vault/format';

interface Captured {
	url: string;
	method: string;
	auth: string | null;
	contentType: string | null;
	body: BodyInit | null;
}

let captured: Captured[];
let originalFetch: typeof fetch;

function mock(response: unknown, status = 200) {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		captured.push({
			url: String(input),
			method: init?.method ?? 'GET',
			auth: headers.get('Authorization'),
			contentType: headers.get('Content-Type'),
			body: init?.body ?? null
		});
		const body = response instanceof Uint8Array
			? response
			: typeof response === 'string'
				? response
				: JSON.stringify(response);
		return new Response(body, { status });
	}) as typeof fetch;
}

beforeEach(() => {
	captured = [];
	originalFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('current Drive client', () => {
	test('lists header and folder files with server versions', async () => {
		expect(HEADER_FILE_NAME).toBe('simple-vault.v3.header.json');
		mock({ files: [{ id: 'header', name: HEADER_FILE_NAME, version: '7' }] });
		const files = await listVaultFiles('tok');
		expect(files[0].version).toBe('7');
		expect(captured[0].url).toContain('spaces=appDataFolder');
		expect(captured[0].url).toContain('version');
		expect(captured[0].auth).toBe('Bearer tok');
	});

	test('findHeaderFile returns the current versioned header only', async () => {
		mock({ files: [{ id: 'folder', name: folderFileName('jtfano2b') }] });
		expect(await findHeaderFile('tok')).toBeNull();
		mock({ files: [{ id: 'old-header', name: 'simple-vault.header.json' }] });
		expect(await findHeaderFile('tok')).toBeNull();
	});

	test('round-trips folder filenames', () => {
		expect(folderFileName('jtfano2b')).toBe('simple-vault.v3.folder.jtfano2b.svf');
		expect(folderIdFromFileName(folderFileName('jtfano2b'))).toBe('jtfano2b');
		expect(folderIdFromFileName('simple-vault.folder.jtfano2b.svf')).toBeNull();
		expect(folderIdFromFileName('other.bin')).toBeNull();
	});

	test('creates and recognizes isolated backup filenames', () => {
		const name = backupFileName(new Date('2026-07-16T18:30:00.000Z'), '1234abcd');
		expect(name).toBe(`${BACKUP_FILE_PREFIX}2026-07-16T18-30-00-000Z.1234abcd.svault`);
		expect(isBackupFileName(name)).toBe(true);
		expect(isBackupFileName(folderFileName('jtfano2b'))).toBe(false);
	});

	test('lists only valid backup files newest first', async () => {
		const oldName = backupFileName(new Date('2026-07-15T00:00:00.000Z'), 'old00000');
		const newName = backupFileName(new Date('2026-07-16T00:00:00.000Z'), 'new00000');
		mock({
			files: [
				{ id: 'old', name: oldName, createdTime: '2026-07-15T00:00:00.000Z', size: '12' },
				{ id: 'not-backup', name: `${BACKUP_FILE_PREFIX}partial` },
				{ id: 'new', name: newName, createdTime: '2026-07-16T00:00:00.000Z', size: '34' }
			]
		});
		const files = await listBackupFiles('tok');
		expect(files.map((file) => file.id)).toEqual(['new', 'old']);
		expect(captured[0].url).toContain('spaces=appDataFolder');
		expect(captured[0].url).toContain('orderBy=createdTime%20desc');
	});

	test('downloads JSON and raw bytes', async () => {
		mock({ format: HEADER_FORMAT });
		expect((await downloadJson<{ format: number }>('tok', 'header')).format).toBe(HEADER_FORMAT);
		mock(new Uint8Array([1, 2, 3]));
		expect(await downloadBytes('tok', 'folder')).toEqual(new Uint8Array([1, 2, 3]));
	});

	test('creates a binary multipart file in appDataFolder', async () => {
		mock({ id: 'newid' });
		expect(await createBinaryFile('tok', folderFileName('jtfano2b'), new Uint8Array([1, 2]))).toBe(
			'newid'
		);
		expect(captured[0].method).toBe('POST');
		expect(captured[0].contentType).toContain('multipart/related');
		const text = await (captured[0].body as Blob).text();
		expect(text).toContain('appDataFolder');
		expect(text).toContain(folderFileName('jtfano2b'));
	});

	test('patches binary folder content without JSON/Base64', async () => {
		mock({});
		await updateBinaryFile('tok', 'folder', new Uint8Array([1, 2, 3]));
		expect(captured[0].method).toBe('PATCH');
		expect(captured[0].contentType).toBe('application/cbor');
		expect(captured[0].body).toEqual(new Uint8Array([1, 2, 3]));
	});

	test('permanently deletes an app-data file', async () => {
		mock({});
		await deleteFile('tok', 'backup/id');
		expect(captured[0].method).toBe('DELETE');
		expect(captured[0].url).toEndWith('/files/backup%2Fid');
	});

	test('throws on a non-ok response', async () => {
		mock('nope', 403);
		await expect(findHeaderFile('tok')).rejects.toThrow('403');
	});
});
