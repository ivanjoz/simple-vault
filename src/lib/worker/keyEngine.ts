// The key-owning crypto engine. Plaintext record/history values never need to
// leave this worker together: callers request metadata, secrets, or history.

import {
	aesDecrypt,
	aesEncrypt,
	bytesToEncBlob,
	bytesToBase64,
	createVault,
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
import type { Bytes, KdfParams, VaultHeader } from '$lib/crypto';
import { decodeCbor, encodeCbor } from '$lib/vault/cbor';
import { HEADER_FORMAT, VAULT_AAD_NAMESPACE } from '$lib/vault/format';
import type {
	Folder,
	HistoryItem,
	PlainRecord,
	RecordData,
	StoredRecord
} from '$lib/vault/types';
import type { KeyOp, KeyOps } from './protocol.ts';

const SALT_BYTES = 16;

export class KeyEngine {
	private dek: CryptoKey | null = null;
	private dekBytes: Bytes | null = null;

	async handle(op: KeyOp, payload: unknown): Promise<unknown> {
		switch (op) {
			case 'create': return this.create(payload as KeyOps['create']['req']);
			case 'unlock': return this.unlock(payload as KeyOps['unlock']['req']);
			case 'lock': return this.lock();
			case 'status': return this.status();
			case 'exportDek': return this.exportDek();
			case 'restoreDek': return this.restoreDek(payload as KeyOps['restoreDek']['req']);
			case 'encryptRecords': return this.encryptRecords(payload as KeyOps['encryptRecords']['req']);
			case 'decryptMetas': return this.decryptMetas(payload as KeyOps['decryptMetas']['req']);
			case 'decryptSecret': return this.decryptSecret(payload as KeyOps['decryptSecret']['req']);
			case 'decryptHistory': return this.decryptHistory(payload as KeyOps['decryptHistory']['req']);
			case 'encryptFolders': return this.encryptFolders(payload as KeyOps['encryptFolders']['req']);
			case 'decryptFolders': return this.decryptFolders(payload as KeyOps['decryptFolders']['req']);
			case 'decryptRecoveryKey': return this.getRecoveryKey(payload as KeyOps['decryptRecoveryKey']['req']);
			case 'changeMasterPassword': return this.changeMasterPassword(payload as KeyOps['changeMasterPassword']['req']);
			case 'regenerateRecoveryKey': return this.regenerateRecoveryKey(payload as KeyOps['regenerateRecoveryKey']['req']);
			default: throw new Error(`unknown op: ${op as string}`);
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
		const { header, recoveryKey, dek, dekBytes } = await createVault(req.masterPassword, {
			kdf: req.kdf
		});
		this.setDek(dek, dekBytes);
		return { header, recoveryKey };
	}

	private async unlock(req: KeyOps['unlock']['req']): Promise<KeyOps['unlock']['res']> {
		try {
			const dekBytes = await unlockDekBytes(req.header, req.secret, req.method);
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
		return { dek: new Uint8Array(this.requireDekBytes()) };
	}

	private async restoreDek(req: KeyOps['restoreDek']['req']): Promise<KeyOps['restoreDek']['res']> {
		try {
			const bytes = new Uint8Array(req.dek);
			this.setDek(await importDek(bytes), bytes);
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}

	private async encryptRecords(
		records: PlainRecord[],
		dek = this.requireDek()
	): Promise<StoredRecord[]> {
		const stored: StoredRecord[] = [];
		for (const record of records) {
			const item: StoredRecord = {
				id: record.id,
				folderId: record.folderId,
				updated: record.updated,
				status: 'active',
				enc_data: await encryptCbor(
					dek,
					record.data,
					aad('record', record.folderId, record.id, record.updated)
				)
			};
			if (record.history.length) {
				item.historyUpdated = record.historyUpdated ?? record.updated;
				item.enc_history = await encryptCbor(
					dek,
					record.history,
					aad('history', record.folderId, record.id, item.historyUpdated)
				);
			}
			stored.push(item);
		}
		return stored;
	}

	private async decryptMetas(records: StoredRecord[]): Promise<KeyOps['decryptMetas']['res']> {
		const dek = this.requireDek();
		const metas = [];
		for (const record of records) {
			const [title, username] = await this.decryptRecordData(dek, record);
			metas.push({ title, username });
		}
		return metas;
	}

	private async decryptSecret(record: StoredRecord): Promise<KeyOps['decryptSecret']['res']> {
		const [, , password, url, notes] = await this.decryptRecordData(this.requireDek(), record);
		return { password, url, notes };
	}

	private decryptHistory(record: StoredRecord): Promise<HistoryItem[]> {
		return this.decryptStoredHistory(this.requireDek(), record);
	}

	private async decryptRecordData(dek: CryptoKey, record: StoredRecord): Promise<RecordData> {
		if (!record.enc_data) throw new Error('record has no encrypted data');
		const data = await decryptCbor(
			dek,
			record.enc_data,
			aad('record', record.folderId, record.id, record.updated)
		);
		if (!Array.isArray(data) || data.length !== 5 || data.some((value) => typeof value !== 'string')) {
			throw new Error('invalid record data');
		}
		return data as RecordData;
	}

	private async decryptStoredHistory(dek: CryptoKey, record: StoredRecord): Promise<HistoryItem[]> {
		if (!record.enc_history || record.historyUpdated === undefined) return [];
		const history = await decryptCbor(
			dek,
			record.enc_history,
			aad('history', record.folderId, record.id, record.historyUpdated)
		);
		if (!Array.isArray(history)) throw new Error('invalid history data');
		return history as HistoryItem[];
	}

	private async encryptFolders(input: Folder[]): Promise<Folder[]> {
		const dek = this.requireDek();
		const folders: Folder[] = [];
		for (const folder of input) {
			folders.push({
				...folder,
				enc_name: await encryptCbor(dek, [folder.name], aad('folder', folder.id, folder.id, folder.updated))
			});
		}
		return folders;
	}

	private async decryptFolders(input: Folder[]): Promise<Folder[]> {
		const dek = this.requireDek();
		const folders: Folder[] = [];
		for (const folder of input) {
			if (!folder.enc_name) throw new Error('folder name is not encrypted');
			const value = await decryptCbor(
				dek,
				folder.enc_name,
				aad('folder', folder.id, folder.id, folder.updated)
			);
			if (!Array.isArray(value) || typeof value[0] !== 'string') throw new Error('invalid folder data');
			folders.push({ ...folder, name: value[0] });
		}
		return folders;
	}

	private async getRecoveryKey(req: KeyOps['decryptRecoveryKey']['req']): Promise<KeyOps['decryptRecoveryKey']['res']> {
		return { recoveryKey: await decryptRecoveryKey(req.header, this.requireDek()) };
	}

	private async changeMasterPassword(req: KeyOps['changeMasterPassword']['req']): Promise<KeyOps['changeMasterPassword']['res']> {
		const oldDek = this.requireDek();
		const recoveryKey = await decryptRecoveryKey(req.currentHeader, oldDek);
		const plains: PlainRecord[] = [];
		for (const stored of req.stored) {
			if (stored.status === 'deleted') continue;
			plains.push({
				id: stored.id,
				folderId: stored.folderId,
				updated: stored.updated,
				data: await this.decryptRecordData(oldDek, stored),
				history: await this.decryptStoredHistory(oldDek, stored),
				historyUpdated: stored.historyUpdated
			});
		}

		const header = await this.rekey(req.currentHeader.kdf, req.newPassword, recoveryKey);
		const stored = [
			...(await this.encryptRecords(plains)),
			...req.stored.filter((record) => record.status === 'deleted')
		];
		const folders = await this.encryptFolders(req.folders);
		return { header, stored, folders };
	}

	private async regenerateRecoveryKey(req: KeyOps['regenerateRecoveryKey']['req']): Promise<KeyOps['regenerateRecoveryKey']['res']> {
		const dek = this.requireDek();
		const recoveryKey = generateRecoveryKey();
		const saltRecovery = randomBytes(SALT_BYTES);
		const kekRecovery = await deriveKek(normalizeRecoveryKey(recoveryKey), saltRecovery, req.currentHeader.kdf);
		const header: VaultHeader = {
			...req.currentHeader,
			saltRecovery: bytesToBase64(saltRecovery),
			wrappedDEK_recovery: bytesToEncBlob(await wrapDek(this.requireDekBytes(), kekRecovery)),
			enc_recoveryKey: await encryptJson(dek, recoveryKey),
			updated: Math.floor(Date.now() / 1000)
		};
		return { header, recoveryKey };
	}

	private async rekey(kdf: KdfParams, password: string, recoveryKey: string): Promise<VaultHeader> {
		const dekBytes = generateDekBytes();
		const dek = await importDek(dekBytes);
		const saltPassword = randomBytes(SALT_BYTES);
		const saltRecovery = randomBytes(SALT_BYTES);
		const kekPassword = await deriveKek(password, saltPassword, kdf);
		const kekRecovery = await deriveKek(normalizeRecoveryKey(recoveryKey), saltRecovery, kdf);
		const header: VaultHeader = {
			format: HEADER_FORMAT,
			kdf,
			saltPassword: bytesToBase64(saltPassword),
			saltRecovery: bytesToBase64(saltRecovery),
			wrappedDEK_password: bytesToEncBlob(await wrapDek(dekBytes, kekPassword)),
			wrappedDEK_recovery: bytesToEncBlob(await wrapDek(dekBytes, kekRecovery)),
			enc_recoveryKey: await encryptJson(dek, recoveryKey),
			updated: Math.floor(Date.now() / 1000)
		};
		this.setDek(dek, dekBytes);
		return header;
	}
}

function aad(kind: string, folderId: string, id: string, updated: number): Bytes {
	return new TextEncoder().encode(
		`${VAULT_AAD_NAMESPACE}\0${kind}\0${folderId}\0${id}\0${updated}`
	) as Bytes;
}

function encryptCbor(dek: CryptoKey, value: unknown, additionalData: Bytes): Promise<Bytes> {
	return aesEncrypt(dek, encodeCbor(value), additionalData);
}

async function decryptCbor(
	dek: CryptoKey,
	packed: Bytes,
	additionalData: Bytes
): Promise<unknown> {
	return decodeCbor(await aesDecrypt(dek, packed, additionalData));
}
