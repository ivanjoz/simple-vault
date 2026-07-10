import { describe, expect, test } from 'bun:test';

import { KeyEngine } from './keyEngine.ts';
import type { KeyOp, KeyOps } from './protocol.ts';
import type { PlainRecord } from '../vault/types.ts';

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

describe('KeyEngine', () => {
	test('create unlocks with an empty vault', async () => {
		const { engine, created } = await unlockedEngine();
		expect((await call(engine, 'status', {})).unlocked).toBe(true);
		const { stored, folders } = await call(engine, 'ingestCiphertext', {
			blob: created.envelope.ciphertext,
			localUpdated: {}
		});
		expect(stored).toEqual([]);
		expect(folders).toEqual([]);
	});

	test('ingest + export round-trip records and honour the delta', async () => {
		const { engine } = await unlockedEngine();
		const rec: PlainRecord = {
			id: '1',
			folderId: 'f',
			updated: 42,
			status: 'active',
			title: 'GitHub',
			username: 'octocat',
			password: 'hunter2',
			notes: 'n',
			history: []
		};
		const { stored } = await call(engine, 'encryptRecords', { records: [rec] });
		const { blob } = await call(engine, 'exportCiphertext', { stored, folders: [] });

		// Fresh local: the record comes back re-encrypted and decryptable.
		const pulled = await call(engine, 'ingestCiphertext', { blob, localUpdated: {} });
		expect(pulled.stored.length).toBe(1);
		const { secret } = await call(engine, 'decryptSecret', { blob: pulled.stored[0].enc_secret });
		expect(secret.password).toBe('hunter2');

		// Up-to-date local: delta returns nothing.
		const noop = await call(engine, 'ingestCiphertext', { blob, localUpdated: { '1': 42 } });
		expect(noop.stored).toEqual([]);
	});

	test('encrypts records and decrypts meta/secret separately', async () => {
		const { engine } = await unlockedEngine();
		const rec: PlainRecord = {
			id: '1',
			folderId: 'f',
			updated: 1,
			status: 'active',
			title: 'GitHub',
			username: 'octocat',
			password: 'hunter2',
			notes: 'n',
			history: [{ p: 'old', u: 1 }]
		};
		const { stored } = await call(engine, 'encryptRecords', { records: [rec] });
		expect(stored[0].id).toBe('1');

		const { metas } = await call(engine, 'decryptMetas', { items: [stored[0].enc_meta] });
		expect(metas[0]).toEqual({ title: 'GitHub', username: 'octocat' });

		const { secret } = await call(engine, 'decryptSecret', { blob: stored[0].enc_secret });
		expect(secret).toEqual({ password: 'hunter2', notes: 'n', history: [{ p: 'old', u: 1 }] });
	});

	test('lock clears the key and further ops throw', async () => {
		const { engine } = await unlockedEngine();
		await call(engine, 'lock', {});
		expect((await call(engine, 'status', {})).unlocked).toBe(false);
		await expect(
			call(engine, 'decryptSecret', { blob: { iv: '', data: '' } })
		).rejects.toThrow('locked');
	});

	test('a fresh engine unlocks with the right password only', async () => {
		const { created } = await unlockedEngine();
		const engine = new KeyEngine();
		expect(
			(await call(engine, 'unlock', { envelope: created.envelope, secret: 'nope', method: 'password' }))
				.ok
		).toBe(false);
		expect(
			(await call(engine, 'unlock', { envelope: created.envelope, secret: 'pw', method: 'password' }))
				.ok
		).toBe(true);
	});

	test('a fresh engine unlocks with the recovery key', async () => {
		const { created } = await unlockedEngine();
		const engine = new KeyEngine();
		const ok = (
			await call(engine, 'unlock', {
				envelope: created.envelope,
				secret: created.recoveryKey,
				method: 'recovery'
			})
		).ok;
		expect(ok).toBe(true);
		const { recoveryKey } = await call(engine, 'decryptRecoveryKey', { envelope: created.envelope });
		expect(recoveryKey).toBe(created.recoveryKey);
	});

	test('changeMasterPassword rotates the DEK; new password + old recovery both work', async () => {
		const { engine, created } = await unlockedEngine(); // password 'pw'
		const rec: PlainRecord = {
			id: '1',
			folderId: '',
			updated: 1,
			status: 'active',
			title: 't',
			username: 'u',
			password: 'p1',
			notes: 'n',
			history: []
		};
		const { stored } = await call(engine, 'encryptRecords', { records: [rec] });
		const res = await call(engine, 'changeMasterPassword', {
			newPassword: 'newpw',
			currentEnvelope: created.envelope,
			stored,
			folders: []
		});
		// Returned records are re-encrypted under the new DEK.
		const { secret } = await call(engine, 'decryptSecret', { blob: res.stored[0].enc_secret });
		expect(secret.password).toBe('p1');

		const withNew = new KeyEngine();
		expect(
			(await call(withNew, 'unlock', { envelope: res.envelope, secret: 'newpw', method: 'password' }))
				.ok
		).toBe(true);
		const withOld = new KeyEngine();
		expect(
			(await call(withOld, 'unlock', { envelope: res.envelope, secret: 'pw', method: 'password' })).ok
		).toBe(false);
		const withRecovery = new KeyEngine();
		expect(
			(
				await call(withRecovery, 'unlock', {
					envelope: res.envelope,
					secret: created.recoveryKey,
					method: 'recovery'
				})
			).ok
		).toBe(true);
	});

	test('regenerateRecoveryKey: new key works, old fails, password unchanged', async () => {
		const { engine, created } = await unlockedEngine(); // password 'pw'
		const res = await call(engine, 'regenerateRecoveryKey', { currentEnvelope: created.envelope });
		expect(res.recoveryKey).not.toBe(created.recoveryKey);

		const withNew = new KeyEngine();
		expect(
			(
				await call(withNew, 'unlock', {
					envelope: res.envelope,
					secret: res.recoveryKey,
					method: 'recovery'
				})
			).ok
		).toBe(true);
		const withOld = new KeyEngine();
		expect(
			(
				await call(withOld, 'unlock', {
					envelope: res.envelope,
					secret: created.recoveryKey,
					method: 'recovery'
				})
			).ok
		).toBe(false);
		const withPassword = new KeyEngine();
		expect(
			(await call(withPassword, 'unlock', { envelope: res.envelope, secret: 'pw', method: 'password' }))
				.ok
		).toBe(true);
	});

	test('exportDek / restoreDek round-trips the session key', async () => {
		const { engine, created } = await unlockedEngine();
		const { dek } = await call(engine, 'exportDek', {});
		const restored = new KeyEngine();
		expect((await call(restored, 'restoreDek', { dek })).ok).toBe(true);
		expect((await call(restored, 'status', {})).unlocked).toBe(true);
		const pulled = await call(restored, 'ingestCiphertext', {
			blob: created.envelope.ciphertext,
			localUpdated: {}
		});
		expect(pulled.stored).toEqual([]);
	});
});
