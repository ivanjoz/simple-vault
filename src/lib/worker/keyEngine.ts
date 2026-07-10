// The crypto engine that owns the DEK. Runs inside the Web Worker, but is a
// plain class with no worker globals so it can be unit-tested directly.

import {
	base64ToBytes,
	bytesToBase64,
	createVault,
	decryptJson,
	decryptRecoveryKey,
	deriveKek,
	encryptJson,
	generateDekBytes,
	generateRecoveryKey,
	importDek,
	normalizeRecoveryKey,
	randomBytes,
	unlockDekBytes,
	wrapDek
} from '$lib/crypto';
import type { Bytes, KdfParams, VaultEnvelope } from '$lib/crypto';
import type {
	Folder,
	MetaPlain,
	PlainRecord,
	SecretPlain,
	StoredRecord,
	VaultData
} from '$lib/vault/types';
import { EMPTY_VAULT_DATA } from '$lib/vault/types';
import { selectChangedRecords } from '$lib/sync/delta';
import type { KeyOp, KeyOps } from './protocol.ts';

const SALT_BYTES = 16;

export class KeyEngine {
	/** The Data Encryption Key — held only in this worker, never returned. */
	private dek: CryptoKey | null = null;
	/** Raw DEK bytes, retained (worker-only) so the recovery key can be re-wrapped. */
	private dekBytes: Bytes | null = null;

	async handle(op: KeyOp, payload: unknown): Promise<unknown> {
		switch (op) {
			case 'create':
				return this.create(payload as KeyOps['create']['req']);
			case 'unlock':
				return this.unlock(payload as KeyOps['unlock']['req']);
			case 'lock':
				return this.lock();
			case 'status':
				return this.status();
			case 'exportDek':
				return this.exportDek();
			case 'restoreDek':
				return this.restoreDek(payload as KeyOps['restoreDek']['req']);
			case 'ingestCiphertext':
				return this.ingestCiphertext(payload as KeyOps['ingestCiphertext']['req']);
			case 'exportCiphertext':
				return this.exportCiphertext(payload as KeyOps['exportCiphertext']['req']);
			case 'encryptRecords':
				return this.encryptRecords(payload as KeyOps['encryptRecords']['req']);
			case 'decryptMetas':
				return this.decryptMetas(payload as KeyOps['decryptMetas']['req']);
			case 'decryptSecret':
				return this.decryptSecret(payload as KeyOps['decryptSecret']['req']);
			case 'decryptRecoveryKey':
				return this.decryptRecoveryKey(payload as KeyOps['decryptRecoveryKey']['req']);
			case 'changeMasterPassword':
				return this.changeMasterPassword(payload as KeyOps['changeMasterPassword']['req']);
			case 'regenerateRecoveryKey':
				return this.regenerateRecoveryKey(payload as KeyOps['regenerateRecoveryKey']['req']);
			default:
				throw new Error(`unknown op: ${op as string}`);
		}
	}

	private requireDek(): CryptoKey {
		if (!this.dek) throw new Error('vault is locked');
		return this.dek;
	}

	private requireDekBytes(): Bytes {
		if (!this.dekBytes) throw new Error('vault is locked');
		return this.dekBytes;
	}

	private setDek(dek: CryptoKey, dekBytes: Bytes): void {
		if (this.dekBytes) this.dekBytes.fill(0);
		this.dek = dek;
		this.dekBytes = dekBytes;
	}

	private async create(req: KeyOps['create']['req']): Promise<KeyOps['create']['res']> {
		const { envelope, recoveryKey, dek, dekBytes } = await createVault(req.masterPassword, {
			initialData: EMPTY_VAULT_DATA,
			kdf: req.kdf
		});
		this.setDek(dek, dekBytes);
		return { envelope, recoveryKey };
	}

	private async unlock(req: KeyOps['unlock']['req']): Promise<KeyOps['unlock']['res']> {
		try {
			const dekBytes = await unlockDekBytes(req.envelope, req.secret, req.method);
			this.setDek(await importDek(dekBytes), dekBytes);
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}

	private lock(): KeyOps['lock']['res'] {
		if (this.dekBytes) this.dekBytes.fill(0);
		this.dek = null;
		this.dekBytes = null;
		return { unlocked: false };
	}

	private status(): KeyOps['status']['res'] {
		return { unlocked: this.dek !== null };
	}

	private exportDek(): KeyOps['exportDek']['res'] {
		return { dek: bytesToBase64(this.requireDekBytes()) };
	}

	private async restoreDek(req: KeyOps['restoreDek']['req']): Promise<KeyOps['restoreDek']['res']> {
		try {
			const bytes = base64ToBytes(req.dek);
			this.setDek(await importDek(bytes), bytes);
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}

	private async ingestCiphertext(
		req: KeyOps['ingestCiphertext']['req']
	): Promise<KeyOps['ingestCiphertext']['res']> {
		const dek = this.requireDek();
		const data = await decryptJson<VaultData>(dek, req.blob);
		const changed = selectChangedRecords(req.localUpdated, data.records);
		return { stored: await this.encryptPlainRecords(dek, changed), folders: data.folders };
	}

	private async exportCiphertext(
		req: KeyOps['exportCiphertext']['req']
	): Promise<KeyOps['exportCiphertext']['res']> {
		const dek = this.requireDek();
		const records: PlainRecord[] = [];
		for (const s of req.stored) {
			const meta = await decryptJson<MetaPlain>(dek, s.enc_meta);
			const secret = await decryptJson<SecretPlain>(dek, s.enc_secret);
			records.push(toPlainRecord(s, meta, secret));
		}
		const data: VaultData = { records, folders: req.folders };
		return { blob: await encryptJson(dek, data) };
	}

	private async encryptRecords(
		req: KeyOps['encryptRecords']['req']
	): Promise<KeyOps['encryptRecords']['res']> {
		return { stored: await this.encryptPlainRecords(this.requireDek(), req.records) };
	}

	private async encryptPlainRecords(dek: CryptoKey, records: PlainRecord[]): Promise<StoredRecord[]> {
		const stored: StoredRecord[] = [];
		for (const r of records) {
			const meta: MetaPlain = { title: r.title, username: r.username };
			const secret: SecretPlain = { password: r.password, notes: r.notes, history: r.history };
			stored.push({
				id: r.id,
				folderId: r.folderId,
				updated: r.updated,
				status: r.status,
				enc_meta: await encryptJson(dek, meta),
				enc_secret: await encryptJson(dek, secret)
			});
		}
		return stored;
	}

	private async decryptMetas(
		req: KeyOps['decryptMetas']['req']
	): Promise<KeyOps['decryptMetas']['res']> {
		const dek = this.requireDek();
		const metas: MetaPlain[] = [];
		for (const item of req.items) {
			metas.push(await decryptJson<MetaPlain>(dek, item));
		}
		return { metas };
	}

	private async decryptSecret(
		req: KeyOps['decryptSecret']['req']
	): Promise<KeyOps['decryptSecret']['res']> {
		const secret = await decryptJson<SecretPlain>(this.requireDek(), req.blob);
		return { secret };
	}

	private async decryptRecoveryKey(
		req: KeyOps['decryptRecoveryKey']['req']
	): Promise<KeyOps['decryptRecoveryKey']['res']> {
		const recoveryKey = await decryptRecoveryKey(req.envelope, this.requireDek());
		return { recoveryKey };
	}

	/**
	 * Change the master password by rotating the DEK and re-encrypting everything
	 * (PLAN.md §3.6). The existing recovery key keeps working. Returns the new
	 * envelope plus all records re-encrypted for IndexedDB.
	 */
	private async changeMasterPassword(
		req: KeyOps['changeMasterPassword']['req']
	): Promise<KeyOps['changeMasterPassword']['res']> {
		const oldDek = this.requireDek();
		const recoveryKey = await decryptRecoveryKey(req.currentEnvelope, oldDek);

		const plains: PlainRecord[] = [];
		for (const s of req.stored) {
			const meta = await decryptJson<MetaPlain>(oldDek, s.enc_meta);
			const secret = await decryptJson<SecretPlain>(oldDek, s.enc_secret);
			plains.push(toPlainRecord(s, meta, secret));
		}

		const envelope = await this.rekey(
			req.currentEnvelope.version,
			req.currentEnvelope.kdf,
			req.newPassword,
			recoveryKey,
			plains,
			req.folders
		);
		const stored = await this.encryptPlainRecords(this.requireDek(), plains);
		return { envelope, stored };
	}

	/**
	 * Generate a fresh recovery key and re-wrap the *current* DEK for it
	 * (PLAN.md §3.7). The DEK is unchanged, so IndexedDB records need no rewrite.
	 */
	private async regenerateRecoveryKey(
		req: KeyOps['regenerateRecoveryKey']['req']
	): Promise<KeyOps['regenerateRecoveryKey']['res']> {
		const dek = this.requireDek();
		const dekBytes = this.requireDekBytes();
		const recoveryKey = generateRecoveryKey();
		const saltRecovery = randomBytes(SALT_BYTES);
		const kekRecovery = await deriveKek(
			normalizeRecoveryKey(recoveryKey),
			saltRecovery,
			req.currentEnvelope.kdf
		);
		const envelope: VaultEnvelope = {
			...req.currentEnvelope,
			saltRecovery: bytesToBase64(saltRecovery),
			wrappedDEK_recovery: await wrapDek(dekBytes, kekRecovery),
			enc_recoveryKey: await encryptJson(dek, recoveryKey),
			updated: Date.now()
		};
		return { envelope, recoveryKey };
	}

	/** Build a fresh envelope around a newly generated DEK and adopt it. */
	private async rekey(
		version: number,
		kdf: KdfParams,
		password: string,
		recoveryKey: string,
		records: PlainRecord[],
		folders: Folder[]
	): Promise<VaultEnvelope> {
		const dekBytes = generateDekBytes();
		const dek = await importDek(dekBytes);
		const saltPassword = randomBytes(SALT_BYTES);
		const saltRecovery = randomBytes(SALT_BYTES);
		const kekPassword = await deriveKek(password, saltPassword, kdf);
		const kekRecovery = await deriveKek(normalizeRecoveryKey(recoveryKey), saltRecovery, kdf);
		const data: VaultData = { records, folders };
		const envelope: VaultEnvelope = {
			version,
			kdf,
			saltPassword: bytesToBase64(saltPassword),
			saltRecovery: bytesToBase64(saltRecovery),
			ciphertext: await encryptJson(dek, data),
			wrappedDEK_password: await wrapDek(dekBytes, kekPassword),
			wrappedDEK_recovery: await wrapDek(dekBytes, kekRecovery),
			enc_recoveryKey: await encryptJson(dek, recoveryKey),
			updated: Date.now()
		};
		this.setDek(dek, dekBytes);
		return envelope;
	}
}

/** Reconstruct a PlainRecord from its stored (decrypted) parts — used by the DB layer. */
export function toPlainRecord(
	stored: Pick<StoredRecord, 'id' | 'folderId' | 'updated' | 'status'>,
	meta: MetaPlain,
	secret: SecretPlain
): PlainRecord {
	return {
		id: stored.id,
		folderId: stored.folderId,
		updated: stored.updated,
		status: stored.status,
		title: meta.title,
		username: meta.username,
		password: secret.password,
		notes: secret.notes,
		history: secret.history
	};
}
