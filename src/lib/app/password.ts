// Cryptographically-random password generator.

const SETS = {
	lower: 'abcdefghijkmnpqrstuvwxyz', // no l
	upper: 'ABCDEFGHJKMNPQRSTUVWXYZ', // no I, O
	digits: '23456789', // no 0, 1
	symbols: '!@#$%^&*-_=+?'
};

export interface GenOptions {
	length?: number;
	lower?: boolean;
	upper?: boolean;
	digits?: boolean;
	symbols?: boolean;
}

export function generatePassword(opts: GenOptions = {}): string {
	const { length = 20, lower = true, upper = true, digits = true, symbols = true } = opts;
	let pool = '';
	if (lower) pool += SETS.lower;
	if (upper) pool += SETS.upper;
	if (digits) pool += SETS.digits;
	if (symbols) pool += SETS.symbols;
	if (!pool) pool = SETS.lower;

	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < length; i++) out += pool[bytes[i] % pool.length];
	return out;
}
