// Repository over the Dexie database. All values it reads/writes are already
// encrypted (StoredRecord) or non-sensitive (Folder, meta).

import type { Folder, StoredRecord } from '$lib/vault/types';
import { VaultDB } from './database.ts';

/** Well-known keys in the `meta` table. */
export const META_ENVELOPE = 'envelope';
export const META_DRIVE_FILE_ID = 'driveFileId';
export const META_LAST_SYNC = 'lastSync';
export const META_SETTINGS = 'settings';

export class VaultRepository {
	constructor(private readonly db: VaultDB = new VaultDB()) {}

	// --- Delta support -------------------------------------------------------

	/** `id -> updated` for every local record, for delta comparison on pull. */
	async localUpdatedMap(): Promise<Record<string, number>> {
		const map: Record<string, number> = {};
		await this.db.records.each((r) => {
			map[r.id] = r.updated;
		});
		return map;
	}

	// --- Records -------------------------------------------------------------

	async putRecords(records: StoredRecord[]): Promise<void> {
		if (records.length) await this.db.records.bulkPut(records);
	}

	async getRecord(id: string): Promise<StoredRecord | undefined> {
		return this.db.records.get(id);
	}

	async allRecords(): Promise<StoredRecord[]> {
		return this.db.records.toArray();
	}

	async activeRecords(): Promise<StoredRecord[]> {
		return this.db.records.where('status').equals('active').toArray();
	}

	// --- Folders -------------------------------------------------------------

	async putFolders(folders: Folder[]): Promise<void> {
		if (folders.length) await this.db.folders.bulkPut(folders);
	}

	async allFolders(): Promise<Folder[]> {
		return this.db.folders.toArray();
	}

	async activeFolders(): Promise<Folder[]> {
		return this.db.folders.where('status').equals('active').toArray();
	}

	// --- Meta ----------------------------------------------------------------

	async getMeta<T>(key: string): Promise<T | undefined> {
		const row = await this.db.meta.get(key);
		return row?.value as T | undefined;
	}

	async setMeta(key: string, value: unknown): Promise<void> {
		await this.db.meta.put({ key, value });
	}

	// --- Lifecycle -----------------------------------------------------------

	/** Wipe all local data (e.g. on "disconnect / forget this device"). */
	async clear(): Promise<void> {
		await Promise.all([this.db.records.clear(), this.db.folders.clear(), this.db.meta.clear()]);
	}
}
