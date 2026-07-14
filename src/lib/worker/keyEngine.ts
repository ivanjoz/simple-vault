// The key-owning v2 crypto engine. Plaintext record/history values never need to
// leave this worker together: callers request metadata, secrets, or history.

import {
	base64ToBytes,
	aesDecrypt,
	aesEncrypt,
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
import type { Bytes, EncBlob, KdfParams, VaultHeader } from '$lib/crypto';
import { decodeComponent, encodeComponent } from '$lib/vault/componentCodec';
import {
	historyData,
	parseHistoryData,
	parseRecordData,
	recordData,
	VaultRecord
} from '$lib/vault/record';
import type {
	Folder,
	HistoryItem,
	PlainRecord,
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

	private async encryptRecords(req: KeyOps['encryptRecords']['req']): Promise<KeyOps['encryptRecords']['res']> {
		return { stored: await this.encryptPlainRecords(this.requireDek(), req.records) };
	}

	private async encryptPlainRecords(dek: CryptoKey, records: PlainRecord[]): Promise<StoredRecord[]> {
		const stored: StoredRecord[] = [];
		for (const record of records) {
			const item: StoredRecord = {
				id: record.id,
				folderId: record.folderId,
				updated: record.updated,
				status: record.status,
				enc_data: await encryptCbor(
					dek,
					recordData(record.title, record.username, record.password, record.url, record.notes),
					recordAad(record.folderId, record.id, record.updated)
				)
			};
			if (record.history.length) {
				item.historyUpdated = record.historyUpdated ?? record.updated;
				item.enc_history = await encryptCbor(
					dek,
					historyData(record.history),
					historyAad(record.folderId, record.id, item.historyUpdated)
				);
			}
			stored.push(item);
		}
		return stored;
	}

	private async decryptMetas(req: KeyOps['decryptMetas']['req']): Promise<KeyOps['decryptMetas']['res']> {
		const dek = this.requireDek();
		const metas = [];
		for (const record of req.records) {
			const value = new VaultRecord(await this.decryptRecordData(dek, record));
			metas.push({ title: value.title, username: value.username });
		}
		return { metas };
	}

	private async decryptSecret(req: KeyOps['decryptSecret']['req']): Promise<KeyOps['decryptSecret']['res']> {
		const value = new VaultRecord(await this.decryptRecordData(this.requireDek(), req.record));
		return { secret: value.toSecret() };
	}

	private async decryptHistory(req: KeyOps['decryptHistory']['req']): Promise<KeyOps['decryptHistory']['res']> {
		return { history: await this.decryptStoredHistory(this.requireDek(), req.record) };
	}

	private async decryptRecordData(dek: CryptoKey, record: StoredRecord) {
		return parseRecordData(
			await decryptCbor(
				dek,
				record.enc_data,
				recordAad(record.folderId, record.id, record.updated)
			)
		);
	}

	private async decryptStoredHistory(dek: CryptoKey, record: StoredRecord): Promise<HistoryItem[]> {
		if (!record.enc_history || record.historyUpdated === undefined) return [];
		return parseHistoryData(
			await decryptCbor(
				dek,
				record.enc_history,
				historyAad(record.folderId, record.id, record.historyUpdated)
			)
		);
	}

	private async encryptFolders(req: KeyOps['encryptFolders']['req']): Promise<KeyOps['encryptFolders']['res']> {
		const dek = this.requireDek();
		const folders: Folder[] = [];
		for (const folder of req.folders) {
			folders.push({
				...folder,
				enc_name: await encryptCbor(dek, [folder.name], folderAad(folder.id, folder.updated))
			});
		}
		return { folders };
	}

	private async decryptFolders(req: KeyOps['decryptFolders']['req']): Promise<KeyOps['decryptFolders']['res']> {
		const dek = this.requireDek();
		const folders: Folder[] = [];
		for (const folder of req.folders) {
			if (!folder.enc_name) throw new Error('folder name is not encrypted');
			const value = await decryptCbor(dek, folder.enc_name, folderAad(folder.id, folder.updated));
			if (!Array.isArray(value) || typeof value[0] !== 'string') throw new Error('invalid folder data');
			folders.push({ ...folder, name: value[0] });
		}
		return { folders };
	}

	private async getRecoveryKey(req: KeyOps['decryptRecoveryKey']['req']): Promise<KeyOps['decryptRecoveryKey']['res']> {
		return { recoveryKey: await decryptRecoveryKey(req.header, this.requireDek()) };
	}

	private async changeMasterPassword(req: KeyOps['changeMasterPassword']['req']): Promise<KeyOps['changeMasterPassword']['res']> {
		const oldDek = this.requireDek();
		const recoveryKey = await decryptRecoveryKey(req.currentHeader, oldDek);
		const plains: PlainRecord[] = [];
		for (const stored of req.stored) {
			const value = new VaultRecord(await this.decryptRecordData(oldDek, stored));
			plains.push({
				id: stored.id,
				folderId: stored.folderId,
				updated: stored.updated,
				status: stored.status,
				title: value.title,
				username: value.username,
				password: value.password,
				url: value.siteUrl,
				notes: value.notes,
				history: await this.decryptStoredHistory(oldDek, stored),
				historyUpdated: stored.historyUpdated
			});
		}

		const header = await this.rekey(req.currentHeader.kdf, req.newPassword, recoveryKey);
		const stored = await this.encryptPlainRecords(this.requireDek(), plains);
		const { folders } = await this.encryptFolders({ folders: req.folders });
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
			wrappedDEK_recovery: await wrapDek(this.requireDekBytes(), kekRecovery),
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
			format: 2,
			kdf,
			saltPassword: bytesToBase64(saltPassword),
			saltRecovery: bytesToBase64(saltRecovery),
			wrappedDEK_password: await wrapDek(dekBytes, kekPassword),
			wrappedDEK_recovery: await wrapDek(dekBytes, kekRecovery),
			enc_recoveryKey: await encryptJson(dek, recoveryKey),
			updated: Math.floor(Date.now() / 1000)
		};
		this.setDek(dek, dekBytes);
		return header;
	}
}

function recordAad(folderId: string, id: string, updated: number): Bytes {
	return aad('record', folderId, id, updated);
}

function historyAad(folderId: string, id: string, updated: number): Bytes {
	return aad('history', folderId, id, updated);
}

function folderAad(folderId: string, updated: number): Bytes {
	return aad('folder', folderId, folderId, updated);
}

function aad(kind: string, folderId: string, id: string, updated: number): Bytes {
	return new TextEncoder().encode(`sv2\0${kind}\0${folderId}\0${id}\0${updated}`) as Bytes;
}

function encryptCbor(dek: CryptoKey, value: unknown, additionalData: Bytes): Promise<EncBlob> {
	return aesEncrypt(dek, encodeComponent(value), additionalData);
}

async function decryptCbor(
	dek: CryptoKey,
	blob: EncBlob,
	additionalData: Bytes
): Promise<unknown> {
	return decodeComponent(await aesDecrypt(dek, blob, additionalData));
}
