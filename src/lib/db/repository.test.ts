import { describe, expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

import { VaultDB } from './database.ts';
import { META_LAST_SYNC, VaultRepository } from './repository.ts';
import type { StoredRecord } from '../vault/types.ts';
import type { Bytes } from '../crypto/types.ts';

let counter = 0;
function freshRepo(): VaultRepository {
	// Inject a fresh in-memory IndexedDB per test (Bun has no native indexedDB).
	return new VaultRepository(
		new VaultDB(`test-db-${++counter}`, { indexedDB: new IDBFactory(), IDBKeyRange })
	);
}

const encryptedBytes = new Uint8Array(28) as Bytes;
function stored(id: string, updated: number, status: 'active' | 'deleted' = 'active'): StoredRecord {
	return { id, folderId: 'f', updated, status, enc_data: encryptedBytes };
}

describe('VaultRepository', () => {
	test('stores and reads records', async () => {
		const repo = freshRepo();
		await repo.putRecords([stored('a', 1), stored('b', 2)]);
		expect((await repo.allRecords()).length).toBe(2);
		expect((await repo.getRecord('a'))?.updated).toBe(1);
	});

	test('filters active records (tombstones excluded)', async () => {
		const repo = freshRepo();
		await repo.putRecords([stored('a', 1), stored('b', 2, 'deleted')]);
		const active = await repo.activeRecords();
		expect(active.map((r) => r.id)).toEqual(['a']);
	});

	test('selects records belonging to one folder', async () => {
		const repo = freshRepo();
		await repo.putRecords([stored('a', 1), { ...stored('b', 2), folderId: 'g' }]);
		expect((await repo.recordsForFolder('f')).map((record) => record.id)).toEqual(['a']);
	});

	test('bulkPut upserts by id (delta re-write)', async () => {
		const repo = freshRepo();
		await repo.putRecords([stored('a', 1)]);
		await repo.putRecords([stored('a', 7)]);
		expect((await repo.allRecords()).length).toBe(1);
		expect((await repo.getRecord('a'))?.updated).toBe(7);
	});

	test('meta get/set round-trips', async () => {
		const repo = freshRepo();
		await repo.setMeta(META_LAST_SYNC, 12345);
		expect(await repo.getMeta<number>(META_LAST_SYNC)).toBe(12345);
		expect(await repo.getMeta('missing')).toBeUndefined();
	});

	test('clear wipes everything', async () => {
		const repo = freshRepo();
		await repo.putRecords([stored('a', 1)]);
		await repo.setMeta(META_LAST_SYNC, 1);
		await repo.clear();
		expect((await repo.allRecords()).length).toBe(0);
		expect(await repo.getMeta(META_LAST_SYNC)).toBeUndefined();
	});
});
