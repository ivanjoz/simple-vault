import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createVaultFile, downloadJson, findVaultFile, updateFile } from './client.ts';

interface Captured {
	url: string;
	method: string;
	auth: string | null;
	contentType: string | null;
	body: string | null;
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
			body: (init?.body as string) ?? null
		});
		return new Response(typeof response === 'string' ? response : JSON.stringify(response), {
			status
		});
	}) as typeof fetch;
}

beforeEach(() => {
	captured = [];
	originalFetch = globalThis.fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('drive client', () => {
	test('findVaultFile queries the appDataFolder with auth', async () => {
		mock({ files: [{ id: 'file1', name: 'vault.json' }] });
		const file = await findVaultFile('tok');
		expect(file?.id).toBe('file1');
		expect(captured[0].url).toContain('spaces=appDataFolder');
		expect(captured[0].url).toContain("name%3D'vault.json'"); // encoded q
		expect(captured[0].auth).toBe('Bearer tok');
	});

	test('findVaultFile returns null when absent', async () => {
		mock({ files: [] });
		expect(await findVaultFile('tok')).toBeNull();
	});

	test('downloadJson requests media and parses JSON', async () => {
		mock({ version: 1, updated: 7 });
		const env = await downloadJson<{ version: number }>('tok', 'file1');
		expect(env.version).toBe(1);
		expect(captured[0].url).toContain('/files/file1?alt=media');
	});

	test('createVaultFile posts a multipart upload into appDataFolder', async () => {
		mock({ id: 'newid' });
		const id = await createVaultFile('tok', { ciphertext: 'x' });
		expect(id).toBe('newid');
		expect(captured[0].method).toBe('POST');
		expect(captured[0].url).toContain('uploadType=multipart');
		expect(captured[0].contentType).toContain('multipart/related');
		expect(captured[0].body).toContain('appDataFolder');
		expect(captured[0].body).toContain('vault.json');
	});

	test('updateFile patches the media content', async () => {
		mock({});
		await updateFile('tok', 'file1', { ciphertext: 'y' });
		expect(captured[0].method).toBe('PATCH');
		expect(captured[0].url).toContain('/files/file1?uploadType=media');
		expect(captured[0].body).toContain('"ciphertext":"y"');
	});

	test('throws on a non-ok response', async () => {
		mock('nope', 403);
		await expect(findVaultFile('tok')).rejects.toThrow('403');
	});
});
