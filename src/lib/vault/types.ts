// Application and local IndexedDB models for the current per-folder format.

import type { Bytes } from '$lib/crypto';

export type RecordStatus = 'active' | 'deleted';

/** Previous password and the Unix-second update that replaced it. */
export type HistoryItem = [password: string, updated: number];

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

/** Transient value accepted by the crypto worker for an edit/rekey. */
export interface PlainRecord {
	id: string;
	folderId: string;
	updated: number;
	data: RecordData;
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
	/** Packed AES-GCM bytes: IV | ciphertext | authentication tag. */
	/** Absent on deletion tombstones. */
	enc_data?: Bytes;
	enc_history?: Bytes;
	historyUpdated?: number;
}

export interface Folder {
	id: string;
	name: string;
	updated: number;
	status: RecordStatus;
	/** Packed encrypted name used directly when rebuilding the Drive folder file. */
	enc_name?: Bytes;
}

/** Decrypted metadata for rendering a card (no secret material). */
export interface CardView {
	id: string;
	folderId: string;
	updated: number;
	title: string;
	username: string;
	/** A local change to this record has not completed a Google Drive sync yet. */
	syncPending: boolean;
}
