import type { Bytes, VaultHeader } from '$lib/crypto';
import { decodeCbor, encodeCbor } from './cbor.ts';
import { decodeFolderFile } from './folderFile.ts';

const FORMAT = 2;

export interface VaultBackup {
	header: VaultHeader;
	folders: Bytes[];
}

export function encodeBackup(header: VaultHeader, folders: Bytes[]): Bytes {
	return encodeCbor([FORMAT, header, folders]);
}

export function decodeBackup(input: Bytes): VaultBackup {
	let value: unknown;
	try {
		value = decodeCbor(input);
	} catch {
		throw new Error('invalid CBOR vault backup');
	}
	if (!Array.isArray(value) || value.length !== 3 || value[0] !== FORMAT) {
		throw new Error('unsupported vault backup format');
	}
	const header = value[1] as VaultHeader;
	if (!header || typeof header !== 'object' || header.format !== FORMAT) {
		throw new Error('invalid vault backup header');
	}
	if (!Array.isArray(value[2])) throw new Error('invalid vault backup folders');
	const folders: Bytes[] = [];
	const folderIds = new Set<string>();
	for (const raw of value[2]) {
		if (!(raw instanceof Uint8Array)) throw new Error('invalid backup folder bytes');
		const bytes = new Uint8Array(raw) as Bytes;
		const id = decodeFolderFile(bytes).folder.id;
		if (folderIds.has(id)) throw new Error('duplicate backup folder');
		folderIds.add(id);
		folders.push(bytes);
	}
	return { header, folders };
}
