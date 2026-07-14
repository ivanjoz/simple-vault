import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
	createBinaryFile,
	downloadBytes,
	downloadJson,
	findHeaderFile,
	folderFileName,
	folderIdFromFileName,
	listVaultFiles,
	updateBinaryFile
} from './client.ts';

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

describe('v2 drive client', () => {
	test('lists header and folder files with server versions', async () => {
		mock({ files: [{ id: 'header', name: 'simple-vault.header.json', version: '7' }] });
		const files = await listVaultFiles('tok');
		expect(files[0].version).toBe('7');
		expect(captured[0].url).toContain('spaces=appDataFolder');
		expect(captured[0].url).toContain('version');
		expect(captured[0].auth).toBe('Bearer tok');
	});

	test('findHeaderFile returns the v2 header only', async () => {
		mock({ files: [{ id: 'folder', name: folderFileName('jtfano2b') }] });
		expect(await findHeaderFile('tok')).toBeNull();
	});

	test('round-trips folder filenames', () => {
		expect(folderIdFromFileName(folderFileName('jtfano2b'))).toBe('jtfano2b');
		expect(folderIdFromFileName('other.bin')).toBeNull();
	});

	test('downloads JSON and raw bytes', async () => {
		mock({ format: 2 });
		expect((await downloadJson<{ format: number }>('tok', 'header')).format).toBe(2);
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

	test('throws on a non-ok response', async () => {
		mock('nope', 403);
		await expect(findHeaderFile('tok')).rejects.toThrow('403');
	});
});
