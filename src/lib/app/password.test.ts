import { describe, expect, test } from 'bun:test';

import { generatePassword } from './password.ts';

describe('generatePassword', () => {
	test('respects the requested length', () => {
		expect(generatePassword({ length: 32 }).length).toBe(32);
	});

	test('uses only the enabled character set', () => {
		const pw = generatePassword({ length: 200, lower: false, upper: false, symbols: false });
		expect(pw).toMatch(/^[23456789]+$/);
	});

	test('produces distinct passwords', () => {
		expect(generatePassword()).not.toBe(generatePassword());
	});
});
