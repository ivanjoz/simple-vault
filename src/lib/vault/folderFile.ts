import { base64ToBytes, bytesToBase64 } from '$lib/crypto';
import type { Bytes, EncBlob } from '$lib/crypto';
import { decodeCbor, encodeCbor } from './cbor.ts';
import type { Folder, StoredRecord } from './types.ts';

const FORMAT = 2;
const ID_BYTES = 5;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DELETED = 1;

type CborRecord = [id: Bytes, updated: number, flags: number, data: Bytes];
type CborHistory = [id: Bytes, updated: number, data: Bytes];
type CborFolder = [
	format: number,
	id: Bytes,
	updated: number,
	flags: number,
	name: Bytes,
	records: CborRecord[],
	histories: CborHistory[]
];

export interface DecodedFolderFile {
	folder: Folder;
	records: StoredRecord[];
}

export function encodeFolderFile(folder: Folder, records: StoredRecord[]): Bytes {
	if (!folder.enc_name) throw new Error('folder name is not encrypted');
	const ordered = [...records].sort((a, b) => a.id.localeCompare(b.id));
	const cborRecords: CborRecord[] = ordered.map((record) => {
		if (record.folderId !== folder.id) throw new Error('record belongs to another folder');
		return [
			encodeId(record.id),
			checkedU32(record.updated),
			record.status === 'deleted' ? DELETED : 0,
			packBlob(record.enc_data)
		];
	});
	const histories: CborHistory[] = ordered
		.filter(
			(record) =>
				record.status === 'active' && record.enc_history && record.historyUpdated !== undefined
		)
		.map((record) => [
			encodeId(record.id),
			checkedU32(record.historyUpdated!),
			packBlob(record.enc_history!)
		]);

	const value: CborFolder = [
		FORMAT,
		encodeId(folder.id),
		checkedU32(folder.updated),
		folder.status === 'deleted' ? DELETED : 0,
		packBlob(folder.enc_name),
		cborRecords,
		histories
	];
	return encodeCbor(value);
}

export function decodeFolderFile(bytes: Bytes): DecodedFolderFile {
	let value: unknown;
	try {
		value = decodeCbor(bytes);
	} catch {
		throw new Error('invalid CBOR folder file');
	}
	if (!Array.isArray(value) || value.length !== 7 || value[0] !== FORMAT) {
		throw new Error('unsupported folder file format');
	}

	const folderId = decodeId(asBytes(value[1]));
	const folder: Folder = {
		id: folderId,
		name: '',
		updated: asU32(value[2]),
		status: flagsToStatus(value[3]),
		enc_name: unpackBlob(asBytes(value[4]))
	};
	if (!Array.isArray(value[5]) || !Array.isArray(value[6])) {
		throw new Error('invalid folder sections');
	}

	const records: StoredRecord[] = [];
	const byId = new Map<string, StoredRecord>();
	for (const raw of value[5]) {
		if (!Array.isArray(raw) || raw.length !== 4) throw new Error('invalid record entry');
		const id = decodeId(asBytes(raw[0]));
		if (byId.has(id)) throw new Error('duplicate record id');
		const record: StoredRecord = {
			id,
			folderId,
			updated: asU32(raw[1]),
			status: flagsToStatus(raw[2]),
			enc_data: unpackBlob(asBytes(raw[3]))
		};
		byId.set(id, record);
		records.push(record);
	}

	const historyIds = new Set<string>();
	for (const raw of value[6]) {
		if (!Array.isArray(raw) || raw.length !== 3) throw new Error('invalid history entry');
		const id = decodeId(asBytes(raw[0]));
		if (historyIds.has(id)) throw new Error('duplicate history id');
		historyIds.add(id);
		const record = byId.get(id);
		if (!record || record.status === 'deleted') throw new Error('orphaned history entry');
		record.historyUpdated = asU32(raw[1]);
		record.enc_history = unpackBlob(asBytes(raw[2]));
	}
	return { folder, records };
}

export function encodeId(id: string): Bytes {
	if (!/^[0-9a-v]{8}$/.test(id)) throw new Error(`invalid compact id: ${id}`);
	const value = Number.parseInt(id, 32);
	if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 40) {
		throw new Error(`invalid compact id: ${id}`);
	}
	const out = new Uint8Array(ID_BYTES);
	let remaining = value;
	for (let index = ID_BYTES - 1; index >= 0; index--) {
		out[index] = remaining % 256;
		remaining = Math.floor(remaining / 256);
	}
	return out;
}

export function decodeId(bytes: Bytes): string {
	if (bytes.length !== ID_BYTES) throw new Error('invalid binary id');
	let value = 0;
	for (const byte of bytes) value = value * 256 + byte;
	return value.toString(32).padStart(8, '0');
}

function packBlob(blob: EncBlob): Bytes {
	const iv = base64ToBytes(blob.iv);
	const encrypted = base64ToBytes(blob.data);
	if (iv.length !== IV_BYTES) throw new Error('invalid AES-GCM IV');
	if (encrypted.length < GCM_TAG_BYTES) throw new Error('invalid AES-GCM ciphertext');
	const packed = new Uint8Array(iv.length + encrypted.length);
	packed.set(iv);
	packed.set(encrypted, iv.length);
	return packed;
}

function unpackBlob(packed: Bytes): EncBlob {
	if (packed.length < IV_BYTES + GCM_TAG_BYTES) throw new Error('invalid encrypted blob');
	return {
		iv: bytesToBase64(packed.slice(0, IV_BYTES) as Bytes),
		data: bytesToBase64(packed.slice(IV_BYTES) as Bytes)
	};
}

function flagsToStatus(value: unknown): 'active' | 'deleted' {
	const flags = asU32(value);
	if ((flags & ~DELETED) !== 0) throw new Error('unsupported folder file flags');
	return flags & DELETED ? 'deleted' : 'active';
}

function asBytes(value: unknown): Bytes {
	if (!(value instanceof Uint8Array)) throw new Error('expected CBOR byte string');
	return new Uint8Array(value) as Bytes;
}

function asU32(value: unknown): number {
	if (typeof value !== 'number') throw new Error('expected CBOR unsigned integer');
	return checkedU32(value);
}

function checkedU32(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
		throw new Error('integer outside folder format range');
	}
	return value;
}
