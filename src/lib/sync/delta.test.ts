import { describe, expect, test } from 'bun:test';

import { mergeById } from './delta.ts';

const rec = (id: string, updated: number) => ({ id, updated });

describe('mergeById', () => {
	test('last-write-wins by updated', () => {
		const local = [rec('a', 10), rec('b', 30)];
		const remote = [rec('a', 20), rec('c', 5)];
		const merged = mergeById(local, remote);
		const byId = Object.fromEntries(merged.map((r) => [r.id, r.updated]));
		expect(byId).toEqual({ a: 20, b: 30, c: 5 });
	});
});
