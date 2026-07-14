// Application and local IndexedDB models for the v2 per-folder format.

import type { EncBlob } from '$lib/crypto';

export type RecordStatus = 'active' | 'deleted';

/** One previous password and the Unix-second update that replaced it. */
export interface HistoryItem {
	p: string;
	u: number;
}

/** Stable positional plaintext encrypted as the main record component. */
export type RecordData = [
	title: string,
	username: string,
	password: string,
	siteUrl: string,
	notes: string
];

/** Fields shown on cards. The worker returns only these after decrypting RecordData. */
export interface MetaPlain {
	title: string;
	username: string;
}

/** Sensitive fields returned only for an explicit record action. */
export interface SecretPlain {
	password: string;
	url: string;
	notes: string;
}

/** Transient full value accepted by the crypto worker for an edit/rekey. */
export interface PlainRecord extends MetaPlain, SecretPlain {
	id: string;
	folderId: string;
	updated: number;
	status: RecordStatus;
	history: HistoryItem[];
	/** Independent history timestamp; absent until history exists. */
	historyUpdated?: number;
}

/** IndexedDB and decoded-folder representation. Ciphertexts remain independent. */
export interface StoredRecord {
	id: string;
	folderId: string;
	updated: number;
	status: RecordStatus;
	enc_data: EncBlob;
	enc_history?: EncBlob;
	historyUpdated?: number;
}

export interface Folder {
	id: string;
	name: string;
	updated: number;
	status: RecordStatus;
	/** Cached encrypted name used when rebuilding the Drive folder file. */
	enc_name?: EncBlob;
}

/** Decrypted metadata for rendering a card (no secret material). */
export interface CardView {
	id: string;
	folderId: string;
	updated: number;
	title: string;
	username: string;
}
