// Google Drive v3 client for the current header + per-folder layout in appDataFolder.

import type { Bytes } from '$lib/crypto';
import { DRIVE_FILE_NAMESPACE } from '$lib/vault/format';

export const HEADER_FILE_NAME = `${DRIVE_FILE_NAMESPACE}.header.json`;
export const FOLDER_FILE_PREFIX = `${DRIVE_FILE_NAMESPACE}.folder.`;
export const FOLDER_FILE_SUFFIX = '.svf';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFile {
	id: string;
	name: string;
	modifiedTime?: string;
	version?: string;
}

async function authed(token: string, url: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${token}`);
	const res = await fetch(url, { ...init, headers });
	if (!res.ok) {
		throw new Error(`Drive API ${res.status}: ${await res.text().catch(() => res.statusText)}`);
	}
	return res;
}

export function folderFileName(folderId: string): string {
	return `${FOLDER_FILE_PREFIX}${folderId}${FOLDER_FILE_SUFFIX}`;
}

export function folderIdFromFileName(name: string): string | null {
	if (!name.startsWith(FOLDER_FILE_PREFIX) || !name.endsWith(FOLDER_FILE_SUFFIX)) return null;
	const id = name.slice(FOLDER_FILE_PREFIX.length, -FOLDER_FILE_SUFFIX.length);
	return /^[0-9a-v]{8}$/.test(id) ? id : null;
}

/** List current-generation vault files. Drive `version` is only a download cache hint. */
export async function listVaultFiles(token: string): Promise<DriveFile[]> {
	const files: DriveFile[] = [];
	let pageToken: string | undefined;
	do {
		const query = encodeURIComponent(
			`(name='${HEADER_FILE_NAME}' or name contains '${FOLDER_FILE_PREFIX}') and trashed=false`
		);
		const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,version)');
		const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
		const res = await authed(token, `${API}/files?spaces=appDataFolder&q=${query}&fields=${fields}${page}`);
		const data = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
		files.push(...(data.files ?? []));
		pageToken = data.nextPageToken;
	} while (pageToken);
	return files;
}

export async function findHeaderFile(token: string): Promise<DriveFile | null> {
	return (await listVaultFiles(token)).find((file) => file.name === HEADER_FILE_NAME) ?? null;
}

export async function downloadJson<T>(token: string, fileId: string): Promise<T> {
	const res = await authed(token, `${API}/files/${fileId}?alt=media`);
	return (await res.json()) as T;
}

export async function downloadBytes(token: string, fileId: string): Promise<Bytes> {
	const res = await authed(token, `${API}/files/${fileId}?alt=media`);
	return new Uint8Array(await res.arrayBuffer());
}

export function createJsonFile(token: string, name: string, data: unknown): Promise<string> {
	return createFile(
		token,
		name,
		new TextEncoder().encode(JSON.stringify(data)) as Bytes,
		'application/json'
	);
}

export function createBinaryFile(token: string, name: string, data: Bytes): Promise<string> {
	return createFile(token, name, data, 'application/cbor');
}

async function createFile(
	token: string,
	name: string,
	data: Bytes,
	contentType: string
): Promise<string> {
	const boundary = `svault${crypto.randomUUID().replaceAll('-', '')}`;
	const metadata = JSON.stringify({ name, parents: ['appDataFolder'] });
	const body = new Blob(
		[
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
			`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
			data,
			`\r\n--${boundary}--`
		],
		{ type: `multipart/related; boundary=${boundary}` }
	);
	const res = await authed(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, {
		method: 'POST',
		headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
		body
	});
	return ((await res.json()) as { id: string }).id;
}

export function updateJsonFile(token: string, fileId: string, data: unknown): Promise<void> {
	return updateFile(token, fileId, JSON.stringify(data), 'application/json');
}

export function updateBinaryFile(token: string, fileId: string, data: Bytes): Promise<void> {
	return updateFile(token, fileId, data, 'application/cbor');
}

async function updateFile(
	token: string,
	fileId: string,
	body: BodyInit,
	contentType: string
): Promise<void> {
	await authed(token, `${UPLOAD}/files/${fileId}?uploadType=media`, {
		method: 'PATCH',
		headers: { 'Content-Type': contentType },
		body
	});
}
