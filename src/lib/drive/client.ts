// Minimal Google Drive v3 client scoped to the hidden appDataFolder (PLAN.md §7).
// The vault is a single JSON file (the encrypted envelope).

export const VAULT_FILE_NAME = 'vault.json';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFile {
	id: string;
	name: string;
	modifiedTime?: string;
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

/** Find the vault file in the app data folder, or null if none exists yet. */
export async function findVaultFile(token: string): Promise<DriveFile | null> {
	const q = encodeURIComponent(`name='${VAULT_FILE_NAME}' and trashed=false`);
	const url = `${API}/files?spaces=appDataFolder&q=${q}&fields=${encodeURIComponent('files(id,name,modifiedTime)')}`;
	const res = await authed(token, url);
	const data = (await res.json()) as { files?: DriveFile[] };
	return data.files?.[0] ?? null;
}

export async function downloadJson<T>(token: string, fileId: string): Promise<T> {
	const res = await authed(token, `${API}/files/${fileId}?alt=media`);
	return (await res.json()) as T;
}

/** Create the vault file in appDataFolder; returns its id. */
export async function createVaultFile(token: string, data: unknown): Promise<string> {
	const boundary = `svault${Math.random().toString(36).slice(2)}`;
	const metadata = { name: VAULT_FILE_NAME, parents: ['appDataFolder'] };
	const body =
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
		`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}\r\n` +
		`--${boundary}--`;
	const res = await authed(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, {
		method: 'POST',
		headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
		body
	});
	const out = (await res.json()) as { id: string };
	return out.id;
}

/** Overwrite the vault file's contents. */
export async function updateFile(token: string, fileId: string, data: unknown): Promise<void> {
	await authed(token, `${UPLOAD}/files/${fileId}?uploadType=media`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(data)
	});
}
