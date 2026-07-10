// RPC protocol between the main thread and the key-holding Web Worker
// (PLAN.md §5.1). The DEK lives only inside the worker; it is never included in
// any response.

import type { EncBlob, KdfParams, VaultEnvelope } from '$lib/crypto';
import type { Folder, MetaPlain, PlainRecord, SecretPlain, StoredRecord } from '$lib/vault/types';

/** Map of operation name -> request/response shapes. */
export interface KeyOps {
	create: {
		req: { masterPassword: string; kdf?: KdfParams };
		res: { envelope: VaultEnvelope; recoveryKey: string };
	};
	unlock: {
		req: { envelope: VaultEnvelope; secret: string; method: 'password' | 'recovery' };
		res: { ok: boolean };
	};
	lock: { req: Record<string, never>; res: { unlocked: false } };
	status: { req: Record<string, never>; res: { unlocked: boolean } };
	/** Export raw DEK bytes (base64) for opt-in sessionStorage persistence. */
	exportDek: { req: Record<string, never>; res: { dek: string } };
	/** Restore the DEK from base64 bytes (persisted session). */
	restoreDek: { req: { dek: string }; res: { ok: boolean } };
	/**
	 * Pull (PLAN.md §6.1): decrypt the Drive ciphertext *inside the worker*, keep
	 * only the records whose `updated` is newer than the local copy, and return
	 * them re-encrypted for IndexedDB. Plaintext secrets never leave the worker.
	 */
	ingestCiphertext: {
		req: { blob: EncBlob; localUpdated: Record<string, number> };
		res: { stored: StoredRecord[]; folders: Folder[] };
	};
	/**
	 * Push (PLAN.md §6.2): decrypt the per-record IndexedDB rows inside the worker,
	 * reassemble the full vault, and return one encrypted ciphertext blob.
	 */
	exportCiphertext: {
		req: { stored: StoredRecord[]; folders: Folder[] };
		res: { blob: EncBlob };
	};
	/** Encrypt plaintext records (user edits) into the per-record IndexedDB form. */
	encryptRecords: { req: { records: PlainRecord[] }; res: { stored: StoredRecord[] } };
	/** Bulk-decrypt card metadata for rendering. */
	decryptMetas: { req: { items: EncBlob[] }; res: { metas: MetaPlain[] } };
	/** Decrypt a single secret on demand (subject to the 40 s TTL on the caller side). */
	decryptSecret: { req: { blob: EncBlob }; res: { secret: SecretPlain } };
	decryptRecoveryKey: { req: { envelope: VaultEnvelope }; res: { recoveryKey: string } };
	/** Rotate the DEK under a new master password; re-encrypts all records (PLAN.md §3.6). */
	changeMasterPassword: {
		req: {
			newPassword: string;
			currentEnvelope: VaultEnvelope;
			stored: StoredRecord[];
			folders: Folder[];
		};
		res: { envelope: VaultEnvelope; stored: StoredRecord[] };
	};
	/** Generate a new recovery key and re-wrap the current DEK for it (PLAN.md §3.7). */
	regenerateRecoveryKey: {
		req: { currentEnvelope: VaultEnvelope };
		res: { envelope: VaultEnvelope; recoveryKey: string };
	};
}

export type KeyOp = keyof KeyOps;

export interface WorkerRequest<O extends KeyOp = KeyOp> {
	id: number;
	op: O;
	payload: KeyOps[O]['req'];
}

export type WorkerResponse<O extends KeyOp = KeyOp> =
	| { id: number; ok: true; result: KeyOps[O]['res'] }
	| { id: number; ok: false; error: string };
