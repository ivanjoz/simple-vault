// RPC protocol between the main thread and the key-holding Web Worker.

import type { Bytes, KdfParams, VaultHeader } from '$lib/crypto';
import type {
	Folder,
	HistoryItem,
	MetaPlain,
	PlainRecord,
	SecretPlain,
	StoredRecord
} from '$lib/vault/types';

export interface KeyOps {
	create: {
		req: { masterPassword: string; kdf?: KdfParams };
		res: { header: VaultHeader; recoveryKey: string };
	};
	unlock: {
		req: { header: VaultHeader; secret: string; method: 'password' | 'recovery' };
		res: { ok: boolean };
	};
	lock: { req: Record<string, never>; res: { unlocked: false } };
	status: { req: Record<string, never>; res: { unlocked: boolean } };
	exportDek: { req: Record<string, never>; res: { dek: Bytes } };
	restoreDek: { req: { dek: Bytes }; res: { ok: boolean } };

	encryptRecords: { req: PlainRecord[]; res: StoredRecord[] };
	decryptMetas: { req: StoredRecord[]; res: MetaPlain[] };
	decryptSecret: { req: StoredRecord; res: SecretPlain };
	decryptHistory: { req: StoredRecord; res: HistoryItem[] };

	encryptFolders: { req: Folder[]; res: Folder[] };
	decryptFolders: { req: Folder[]; res: Folder[] };

	decryptRecoveryKey: { req: { header: VaultHeader }; res: { recoveryKey: string } };
	changeMasterPassword: {
		req: {
			newPassword: string;
			currentHeader: VaultHeader;
			stored: StoredRecord[];
			folders: Folder[];
		};
		res: { header: VaultHeader; stored: StoredRecord[]; folders: Folder[] };
	};
	regenerateRecoveryKey: {
		req: { currentHeader: VaultHeader };
		res: { header: VaultHeader; recoveryKey: string };
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
