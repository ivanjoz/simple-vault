import { describe, expect, test } from 'bun:test';

import { KeyEngine } from './keyEngine.ts';
import type { KeyOp, KeyOps } from './protocol.ts';
import type { Folder, PlainRecord } from '../vault/types.ts';
import { HEADER_FORMAT } from '../vault/format.ts';

const FAST_KDF = { algo: 'argon2id', mem: 1024, iters: 1, parallelism: 1, hashLength: 32 } as const;

function call<O extends KeyOp>(
	engine: KeyEngine,
	op: O,
	payload: KeyOps[O]['req']
): Promise<KeyOps[O]['res']> {
	return engine.handle(op, payload) as Promise<KeyOps[O]['res']>;
}

async function unlockedEngine() {
	const engine = new KeyEngine();
	const created = await call(engine, 'create', { masterPassword: 'pw', kdf: FAST_KDF });
	return { engine, created };
}

function plain(overrides: Partial<PlainRecord> = {}): PlainRecord {
	return {
		id: 'jtfano2b',
		folderId: '00000000',
		updated: 42,
		data: ['GitHub', 'octocat', 'hunter2', 'https://github.com', 'n'],
		history: [['old', 40]],
		historyUpdated: 42,
		...overrides
	};
}

describe('current KeyEngine', () => {
	test('creates an unlocked ciphertext-free header', async () => {
		const { engine, created } = await unlockedEngine();
		expect(created.header.format).toBe(HEADER_FORMAT);
		expect('ciphertext' in created.header).toBe(false);
		expect((await call(engine, 'status', {})).unlocked).toBe(true);
	});

	test('encrypts positional record data and history independently', async () => {
		const { engine } = await unlockedEngine();
		const stored = await call(engine, 'encryptRecords', [plain()]);
		expect(stored[0].enc_data).toBeDefined();
		expect(stored[0].enc_history).toBeDefined();

		const metas = await call(engine, 'decryptMetas', stored);
		expect(metas).toEqual([{ title: 'GitHub', username: 'octocat' }]);
		expect(await call(engine, 'decryptSecret', stored[0])).toEqual({
			password: 'hunter2',
			url: 'https://github.com',
			notes: 'n'
		});
		expect(await call(engine, 'decryptHistory', stored[0])).toEqual([['old', 40]]);
	});

	test('validates all encrypted record components without exposing plaintext', async () => {
		const { engine } = await unlockedEngine();
		const stored = await call(engine, 'encryptRecords', [plain()]);
		expect(await call(engine, 'validateStoredRecords', stored)).toEqual({ valid: true });

		const corruptData = new Uint8Array(stored[0].enc_data!);
		corruptData[corruptData.length - 1] ^= 1;
		await expect(
			call(engine, 'validateStoredRecords', [{ ...stored[0], enc_data: corruptData }])
		).rejects.toThrow();

		const corruptHistory = new Uint8Array(stored[0].enc_history!);
		corruptHistory[corruptHistory.length - 1] ^= 1;
		await expect(
			call(engine, 'validateStoredRecords', [{ ...stored[0], enc_history: corruptHistory }])
		).rejects.toThrow();
	});

	test('omits empty history and returns it without decrypting a blob', async () => {
		const { engine } = await unlockedEngine();
		const stored = await call(engine, 'encryptRecords', [
			plain({ history: [], historyUpdated: undefined })
		]);
		expect(stored[0].enc_history).toBeUndefined();
		expect(await call(engine, 'decryptHistory', stored[0])).toEqual([]);
	});

	test('binds ciphertext to folder, id and updated using AAD', async () => {
		const { engine } = await unlockedEngine();
		const stored = await call(engine, 'encryptRecords', [plain()]);
		await expect(
			call(engine, 'decryptSecret', { ...stored[0], updated: 43 })
		).rejects.toThrow();
	});

	test('encrypts and decrypts folder names', async () => {
		const { engine } = await unlockedEngine();
		const folder: Folder = { id: '00000000', name: 'Personal', updated: 42, status: 'active' };
		const encrypted = (await call(engine, 'encryptFolders', [folder]))[0];
		expect(encrypted.enc_name).toBeDefined();
		expect((await call(engine, 'decryptFolders', [encrypted]))[0].name).toBe(
			'Personal'
		);
	});

	test('lock clears the key and further operations throw', async () => {
		const { engine } = await unlockedEngine();
		const stored = await call(engine, 'encryptRecords', [plain()]);
		await call(engine, 'lock', {});
		expect((await call(engine, 'status', {})).unlocked).toBe(false);
		await expect(call(engine, 'decryptSecret', stored[0])).rejects.toThrow('locked');
	});

	test('fresh engines unlock with password or recovery key', async () => {
		const { created } = await unlockedEngine();
		const password = new KeyEngine();
		expect(
			(await call(password, 'unlock', { header: created.header, secret: 'pw', method: 'password' })).ok
		).toBe(true);
		const recovery = new KeyEngine();
		expect(
			(
				await call(recovery, 'unlock', {
					header: created.header,
					secret: created.recoveryKey,
					method: 'recovery'
				})
			).ok
		).toBe(true);
	});

	test('changeMasterPassword rotates and re-encrypts records, histories and folders', async () => {
		const { engine, created } = await unlockedEngine();
		const stored = await call(engine, 'encryptRecords', [plain()]);
		const folders = await call(engine, 'encryptFolders', [
			{ id: '00000000', name: '', updated: 42, status: 'active' }
		]);
		const result = await call(engine, 'changeMasterPassword', {
			newPassword: 'newpw',
			currentHeader: created.header,
			stored,
			folders
		});
		expect(await call(engine, 'decryptHistory', result.stored[0])).toHaveLength(1);
		expect((await call(engine, 'decryptFolders', result.folders))[0].name).toBe('');

		const fresh = new KeyEngine();
		expect(
			(await call(fresh, 'unlock', { header: result.header, secret: 'newpw', method: 'password' })).ok
		).toBe(true);
		const old = new KeyEngine();
		expect(
			(await call(old, 'unlock', { header: result.header, secret: 'pw', method: 'password' })).ok
		).toBe(false);
	});

	test('regenerates recovery without changing the password path', async () => {
		const { engine, created } = await unlockedEngine();
		const result = await call(engine, 'regenerateRecoveryKey', { currentHeader: created.header });
		expect(result.recoveryKey).not.toBe(created.recoveryKey);
		const fresh = new KeyEngine();
		expect(
			(await call(fresh, 'unlock', { header: result.header, secret: 'pw', method: 'password' })).ok
		).toBe(true);
	});

	test('exportDek / restoreDek round-trips the session key', async () => {
		const { engine } = await unlockedEngine();
		const { dek } = await call(engine, 'exportDek', {});
		const restored = new KeyEngine();
		expect((await call(restored, 'restoreDek', { dek })).ok).toBe(true);
		expect((await call(restored, 'status', {})).unlocked).toBe(true);
	});

	test('previews another backup with a temporary key and preserves the open vault key', async () => {
		const { engine } = await unlockedEngine();
		const currentRecord = (await call(engine, 'encryptRecords', [plain()]))[0];

		const backupEngine = new KeyEngine();
		const backup = await call(backupEngine, 'create', {
			masterPassword: 'backup-password',
			kdf: FAST_KDF
		});
		const folder = (
			await call(backupEngine, 'encryptFolders', [
				{ id: '00000001', name: 'Work', updated: 50, status: 'active' }
			])
		)[0];
		const records = await call(backupEngine, 'encryptRecords', [
			plain({
				id: '00000002',
				folderId: folder.id,
				updated: 51,
				data: ['Email', 'person@example.com', 'backup-secret', '', '']
			})
		]);

		const wrong = await call(engine, 'previewBackup', {
			header: backup.header,
			secret: 'wrong',
			method: 'password',
			folders: [{ folder, records }]
		});
		expect(wrong.ok).toBe(false);

		const result = await call(engine, 'previewBackup', {
			header: backup.header,
			secret: 'backup-password',
			method: 'password',
			folders: [{ folder, records }]
		});
		expect(result).toEqual({
			ok: true,
			preview: {
				folders: [
					{
						id: '00000001',
						name: 'Work',
						updated: 50,
						status: 'active',
						items: [
							{
								id: '00000002',
								updated: 51,
								status: 'active',
								hasHistory: true
							}
						]
					}
				]
			}
		});
		expect((await call(engine, 'decryptSecret', currentRecord)).password).toBe('hunter2');
	});

	test('importBackupRecords re-encrypts a backup under the open vault key', async () => {
		const { engine } = await unlockedEngine();

		const backupEngine = new KeyEngine();
		const backup = await call(backupEngine, 'create', {
			masterPassword: 'backup-password',
			kdf: FAST_KDF
		});
		const folder = (
			await call(backupEngine, 'encryptFolders', [
				{ id: '00000001', name: 'Work', updated: 50, status: 'active' }
			])
		)[0];
		const records = await call(backupEngine, 'encryptRecords', [
			plain({
				id: '00000002',
				folderId: folder.id,
				updated: 51,
				data: ['Email', 'person@example.com', 'backup-secret', '', ''],
				history: [['prev', 49]],
				historyUpdated: 51
			})
		]);
		// A tombstone in the backup must carry over as a tombstone.
		records.push({ id: '00000003', folderId: folder.id, updated: 52, status: 'deleted' });

		const wrong = await call(engine, 'importBackupRecords', {
			header: backup.header,
			secret: 'wrong',
			method: 'password',
			folders: [{ folder, records }]
		});
		expect(wrong.ok).toBe(false);

		const result = await call(engine, 'importBackupRecords', {
			header: backup.header,
			secret: 'backup-password',
			method: 'password',
			folders: [{ folder, records }]
		});
		expect(result.ok).toBe(true);

		// Folder name is readable under the CURRENT vault key.
		expect((await call(engine, 'decryptFolders', result.folders!))[0].name).toBe('Work');

		const active = result.records!.find((record) => record.id === '00000002')!;
		expect(active.updated).toBe(51);
		expect((await call(engine, 'decryptSecret', active)).password).toBe('backup-secret');
		expect(await call(engine, 'decryptHistory', active)).toEqual([['prev', 49]]);

		const tombstone = result.records!.find((record) => record.id === '00000003')!;
		expect(tombstone.status).toBe('deleted');
		expect(tombstone.enc_data).toBeUndefined();
	});

	test('importBackupRecords rejects when the vault is locked', async () => {
		const { engine } = await unlockedEngine();
		const backupEngine = new KeyEngine();
		const backup = await call(backupEngine, 'create', {
			masterPassword: 'backup-password',
			kdf: FAST_KDF
		});
		await call(engine, 'lock', {});
		await expect(
			call(engine, 'importBackupRecords', {
				header: backup.header,
				secret: 'backup-password',
				method: 'password',
				folders: []
			})
		).rejects.toThrow('locked');
	});
});
