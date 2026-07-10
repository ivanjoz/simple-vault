// Dexie (IndexedDB) schema (PLAN.md §4.4). Records are stored with plaintext
// metadata (id / folderId / updated / status) for indexing and delta sync, and
// per-record encrypted `enc_meta` / `enc_secret`. No key material or plaintext
// secret is ever written here.

import Dexie, { type DexieOptions, type Table } from 'dexie';
import type { Folder, StoredRecord } from '$lib/vault/types';

/** Arbitrary app metadata: cached envelope, Drive fileId, last-sync time, settings. */
export interface MetaRow {
	key: string;
	value: unknown;
}

export class VaultDB extends Dexie {
	records!: Table<StoredRecord, string>;
	folders!: Table<Folder, string>;
	meta!: Table<MetaRow, string>;

	// `options` allows injecting an IndexedDB implementation (e.g. fake-indexeddb
	// in tests / non-browser runtimes); in the browser Dexie uses the globals.
	constructor(name = 'simple-vault', options?: DexieOptions) {
		super(name, options);
		this.version(1).stores({
			records: 'id, folderId, updated, status',
			folders: 'id, updated, status',
			meta: 'key'
		});
	}
}
