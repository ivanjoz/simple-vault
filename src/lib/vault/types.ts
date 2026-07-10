// The vault data model (PLAN.md §4).
//
// Two representations exist for a record:
//  - PlainRecord  — full plaintext; this is what lives inside the single
//                   Drive `ciphertext` blob and what we work with in memory
//                   transiently.
//  - StoredRecord — the IndexedDB form: metadata stays plaintext for indexing
//                   and delta sync, while sensitive fields are per-record
//                   encrypted.

import type { EncBlob } from '$lib/crypto';

export type RecordStatus = 'active' | 'deleted';

/** One previous password. Kept minimal: `p` = password, `u` = unix-ms. */
export interface HistoryItem {
	p: string;
	u: number;
}

/** Fields shown on cards (decrypted for display). */
export interface MetaPlain {
	title: string;
	username: string;
}

/** Sensitive fields (decrypted only on demand, ≤ 40 s). */
export interface SecretPlain {
	password: string;
	notes: string;
	history: HistoryItem[];
}

/** Full plaintext record — the Drive/working form. */
export interface PlainRecord extends MetaPlain, SecretPlain {
	id: string;
	folderId: string;
	updated: number;
	status: RecordStatus;
}

/** IndexedDB form — sensitive fields encrypted, metadata plaintext. */
export interface StoredRecord {
	id: string;
	folderId: string;
	updated: number;
	status: RecordStatus;
	enc_meta: EncBlob;
	enc_secret: EncBlob;
}

export interface Folder {
	id: string;
	name: string;
	updated: number;
	status: RecordStatus;
}

/** Decrypted metadata for rendering a card (no secret material). */
export interface CardView {
	id: string;
	folderId: string;
	updated: number;
	title: string;
	username: string;
}

/** The decrypted contents of the Drive envelope's ciphertext. */
export interface VaultData {
	records: PlainRecord[];
	folders: Folder[];
}

export const EMPTY_VAULT_DATA: VaultData = { records: [], folders: [] };
