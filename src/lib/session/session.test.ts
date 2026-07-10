import { describe, expect, test } from 'bun:test';

import { copyWithAutoClear } from './clipboard.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('copyWithAutoClear', () => {
	test('writes the value then clears after the ttl', async () => {
		const writes: string[] = [];
		const handle = copyWithAutoClear('secret', 10, async (t) => {
			writes.push(t);
		});
		await handle.written;
		expect(writes).toEqual(['secret']);
		await wait(30);
		expect(writes).toEqual(['secret', '']);
	});

	test('cancel prevents the clear', async () => {
		const writes: string[] = [];
		const handle = copyWithAutoClear('secret', 10, async (t) => {
			writes.push(t);
		});
		await handle.written;
		handle.cancel();
		await wait(30);
		expect(writes).toEqual(['secret']);
	});
});
