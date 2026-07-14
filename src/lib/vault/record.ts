// Compact, stable plaintext codecs. These tuples are encrypted before storage;
// field names exist only in application code.

import type { HistoryItem, RecordData, SecretPlain } from './types.ts';

export const ROOT_FOLDER_ID = '00000000';

export function createId(now = Date.now()): string {
	return now.toString(32).slice(-8).padStart(8, '0');
}

export function updatedNow(now = Date.now()): number {
	return Math.floor(now / 1000);
}

export function updatedToBase32(updated: number): string {
	return updated.toString(32);
}

export function updatedFromBase32(value: string): number {
	const updated = Number.parseInt(value, 32);
	if (!Number.isSafeInteger(updated) || updated < 0 || updated > 0xffff_ffff) {
		throw new Error('invalid updated timestamp');
	}
	return updated;
}

export class VaultRecord {
	constructor(private readonly data: RecordData) {}

	get title(): string {
		return this.data[0];
	}

	get username(): string {
		return this.data[1];
	}

	get password(): string {
		return this.data[2];
	}

	get siteUrl(): string {
		return this.data[3];
	}

	get notes(): string {
		return this.data[4];
	}

	toData(): RecordData {
		return [...this.data];
	}

	toSecret(): SecretPlain {
		return { password: this.password, url: this.siteUrl, notes: this.notes };
	}
}

export function recordData(
	title: string,
	username: string,
	password: string,
	siteUrl: string,
	notes: string
): RecordData {
	return [title, username, password, siteUrl, notes];
}

export function parseRecordData(value: unknown): RecordData {
	if (
		!Array.isArray(value) ||
		value.length < 5 ||
		!value.slice(0, 5).every((item) => typeof item === 'string')
	) {
		throw new Error('invalid encrypted record data');
	}
	return value.slice(0, 5) as RecordData;
}

export function historyData(history: HistoryItem[]): [string, number][] {
	return history.map((item) => [item.p, item.u]);
}

export function parseHistoryData(value: unknown): HistoryItem[] {
	if (!Array.isArray(value)) throw new Error('invalid encrypted history data');
	return value.map((item) => {
		if (
			!Array.isArray(item) ||
			item.length < 2 ||
			typeof item[0] !== 'string' ||
			!Number.isSafeInteger(item[1]) ||
			item[1] < 0
		) {
			throw new Error('invalid encrypted history item');
		}
		return { p: item[0], u: item[1] };
	});
}
