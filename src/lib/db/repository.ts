// Repository over the Dexie database. All values it reads/writes are already
// encrypted (StoredRecord) or non-sensitive (Folder, meta).

import type { Folder, StoredRecord } from '$lib/vault/types';
import { DRIVE_STORAGE_VERSION } from '$lib/vault/format';
import { VaultDB } from './database.ts';

/** Well-known keys in the `meta` table. */
export const META_HEADER = 'header';
export const META_DRIVE_HEADER_ID = `driveV${DRIVE_STORAGE_VERSION}HeaderId`;
export const META_DRIVE_FOLDER_IDS = `driveV${DRIVE_STORAGE_VERSION}FolderIds`;
export const META_DRIVE_FOLDER_VERSIONS = `driveV${DRIVE_STORAGE_VERSION}FolderVersions`;
export const META_LAST_SYNC = 'lastSync';
/** Record ids with the millisecond timestamp of their latest unsynced local change. */
export const META_PENDING_RECORD_SYNCS = 'pendingRecordSyncs';
export const META_SETTINGS = 'settings';
/** Device-local biometric/PIN unlocker (never synced to Drive). */
export const META_LOCAL_UNLOCK = 'localUnlock';

export class VaultRepository {
	constructor(private readonly db: VaultDB = new VaultDB()) {}

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

	async recordsForFolder(folderId: string): Promise<StoredRecord[]> {
		return this.db.records.where('folderId').equals(folderId).toArray();
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

	async getFolder(id: string): Promise<Folder | undefined> {
		return this.db.folders.get(id);
	}

	// --- Meta ----------------------------------------------------------------

	async getMeta<T>(key: string): Promise<T | undefined> {
		const row = await this.db.meta.get(key);
		return row?.value as T | undefined;
	}

	async setMeta(key: string, value: unknown): Promise<void> {
		await this.db.meta.put({ key, value });
	}

	async deleteMeta(key: string): Promise<void> {
		await this.db.meta.delete(key);
	}

	// --- Lifecycle -----------------------------------------------------------

	/** Wipe all local data (e.g. on "disconnect / forget this device"). */
	async clear(): Promise<void> {
		await Promise.all([this.db.records.clear(), this.db.folders.clear(), this.db.meta.clear()]);
	}
}
