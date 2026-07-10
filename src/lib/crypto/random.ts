// Randomness and recovery-key generation (PLAN.md §3.8).

import type { Bytes } from './types.ts';

/** Crockford base32 alphabet (excludes I, L, O, U to avoid ambiguity). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** How many 4-character groups the recovery key contains. */
export const RECOVERY_KEY_GROUPS = 4;
const GROUP_SIZE = 4;

export function randomBytes(length: number): Bytes {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

/**
 * Generate a recovery key formatted as groups of Crockford-base32 characters,
 * e.g. `A3F9-K72M-BQ8X-P4WD`. 32 is a power of two, so masking the low 5 bits of
 * a random byte is unbiased.
 */
export function generateRecoveryKey(groups = RECOVERY_KEY_GROUPS): string {
	const totalChars = groups * GROUP_SIZE;
	const raw = randomBytes(totalChars);
	const chars: string[] = [];
	for (let i = 0; i < totalChars; i++) {
		chars.push(CROCKFORD[raw[i] & 31]);
	}
	const out: string[] = [];
	for (let g = 0; g < groups; g++) {
		out.push(chars.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE).join(''));
	}
	return out.join('-');
}

/**
 * Canonicalise a user-entered recovery key so it matches the generated form:
 * uppercase, strip separators, and fold ambiguous characters (I/L -> 1, O -> 0,
 * U -> V per Crockford). The result is what gets fed to the KDF.
 */
export function normalizeRecoveryKey(input: string): string {
	return input
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/[IL]/g, '1')
		.replace(/O/g, '0')
		.replace(/U/g, 'V');
}
