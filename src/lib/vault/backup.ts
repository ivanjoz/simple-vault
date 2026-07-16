import type { Bytes, VaultHeader } from '$lib/crypto';
import { decodeCbor, encodeCbor } from './cbor.ts';
import { decodeFolderFile } from './folderFile.ts';
import { BACKUP_FORMAT, HEADER_FORMAT } from './format.ts';
import { ROOT_FOLDER_ID } from './record.ts';

export interface VaultBackup {
	header: VaultHeader;
	folders: Bytes[];
}

export interface BackupManifestItem {
	id: string;
	updated: number;
	status: 'active' | 'deleted';
	hasHistory: boolean;
}

export interface BackupManifestFolder {
	id: string;
	updated: number;
	status: 'active' | 'deleted';
	items: BackupManifestItem[];
}

/** Metadata that is intentionally visible without possessing the backup key. */
export interface BackupManifest {
	format: number;
	headerUpdated: number;
	folderCount: number;
	activeFolderCount: number;
	itemCount: number;
	activeItemCount: number;
	folders: BackupManifestFolder[];
}

export interface BackupPreviewFolder extends Omit<BackupManifestFolder, 'items'> {
	name: string;
	items: BackupManifestItem[];
}

export interface BackupPreview {
	folders: BackupPreviewFolder[];
}

export function encodeBackup(header: VaultHeader, folders: Bytes[]): Bytes {
	return encodeCbor([BACKUP_FORMAT, header, folders]);
}

export function decodeBackup(input: Bytes): VaultBackup {
	let value: unknown;
	try {
		value = decodeCbor(input);
	} catch {
		throw new Error('invalid CBOR vault backup');
	}
	if (!Array.isArray(value) || value.length !== 3 || value[0] !== BACKUP_FORMAT) {
		throw new Error('unsupported vault backup format');
	}
	const header = value[1] as VaultHeader;
	if (!header || typeof header !== 'object' || header.format !== HEADER_FORMAT) {
		throw new Error('invalid vault backup header');
	}
	if (!Array.isArray(value[2])) throw new Error('invalid vault backup folders');
	const folders: Bytes[] = [];
	const folderIds = new Set<string>();
	const recordIds = new Set<string>();
	for (const raw of value[2]) {
		if (!(raw instanceof Uint8Array)) throw new Error('invalid backup folder bytes');
		const bytes = raw as Bytes;
		const decoded = decodeFolderFile(bytes);
		const id = decoded.folder.id;
		if (folderIds.has(id)) throw new Error('duplicate backup folder');
		folderIds.add(id);
		for (const record of decoded.records) {
			if (recordIds.has(record.id)) throw new Error('duplicate backup record');
			recordIds.add(record.id);
		}
		folders.push(bytes);
	}
	return { header, folders };
}

/**
 * Parse the public structure of a backup without attempting to decrypt it.
 * Folder names and record fields are encrypted, but IDs, timestamps, statuses,
 * counts and the presence of history are part of the binary container.
 */
export function inspectBackup(input: Bytes): BackupManifest {
	const bundle = decodeBackup(input);
	const folders = bundle.folders.map((bytes) => {
		const decoded = decodeFolderFile(bytes);
		return {
			id: decoded.folder.id,
			updated: decoded.folder.updated,
			status: decoded.folder.status,
			items: decoded.records.map((record) => ({
				id: record.id,
				updated: record.updated,
				status: record.status,
				hasHistory: record.enc_history !== undefined
			}))
		} satisfies BackupManifestFolder;
	});
	const items = folders.flatMap((folder) => folder.items);
	return {
		format: BACKUP_FORMAT,
		headerUpdated: bundle.header.updated,
		// The root container represents “No folder” in the UI, not a user folder.
		folderCount: folders.filter((folder) => folder.id !== ROOT_FOLDER_ID).length,
		activeFolderCount: folders.filter(
			(folder) => folder.id !== ROOT_FOLDER_ID && folder.status === 'active'
		).length,
		itemCount: items.length,
		activeItemCount: items.filter((item) => item.status === 'active').length,
		folders
	};
}
