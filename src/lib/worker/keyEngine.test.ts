import { describe, expect, test } from 'bun:test';

import { KeyEngine } from './keyEngine.ts';
import type { KeyOp, KeyOps } from './protocol.ts';
import type { Folder, PlainRecord } from '../vault/types.ts';

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

describe('KeyEngine v2', () => {
	test('creates an unlocked ciphertext-free header', async () => {
		const { engine, created } = await unlockedEngine();
		expect(created.header.format).toBe(2);
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
});
