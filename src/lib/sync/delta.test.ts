import { describe, expect, test } from 'bun:test';

import { mergeById, selectChangedRecords } from './delta.ts';
import type { PlainRecord } from '../vault/types.ts';

function rec(id: string, updated: number): PlainRecord {
	return {
		id,
		updated,
		folderId: '',
		status: 'active',
		title: id,
		username: '',
		password: '',
		url: '',
		notes: '',
		history: []
	};
}

describe('selectChangedRecords', () => {
	test('includes new and strictly-newer records, skips unchanged/older', () => {
		const local = { a: 10, b: 20, c: 30 };
		const remote = [rec('a', 15), rec('b', 20), rec('c', 25), rec('d', 5)];
		const changed = selectChangedRecords(local, remote).map((r) => r.id);
		expect(changed.sort()).toEqual(['a', 'd']); // a newer, d new; b equal, c older
	});
});

describe('mergeById', () => {
	test('last-write-wins by updated', () => {
		const local = [rec('a', 10), rec('b', 30)];
		const remote = [rec('a', 20), rec('c', 5)];
		const merged = mergeById(local, remote);
		const byId = Object.fromEntries(merged.map((r) => [r.id, r.updated]));
		expect(byId).toEqual({ a: 20, b: 30, c: 5 });
	});
});
