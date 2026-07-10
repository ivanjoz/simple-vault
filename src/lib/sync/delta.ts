// Pure delta / merge helpers for synchronization (PLAN.md §6). No I/O, no crypto
// — kept side-effect-free so the conflict logic is directly unit-testable.

import type { PlainRecord } from '$lib/vault/types';

interface Versioned {
	id: string;
	updated: number;
}

/**
 * Given the local `id -> updated` map and the remote records, return only those
 * that are new or strictly newer remotely. This is what avoids rewriting
 * unchanged rows into IndexedDB on every pull.
 */
export function selectChangedRecords(
	localUpdated: Record<string, number>,
	remote: PlainRecord[]
): PlainRecord[] {
	return remote.filter((r) => {
		const local = localUpdated[r.id];
		return local === undefined || r.updated > local;
	});
}

/**
 * Merge two sets of versioned items by id using last-write-wins on `updated`.
 * Symmetric, so it works for reconciling either direction.
 */
export function mergeById<T extends Versioned>(local: T[], remote: T[]): T[] {
	const byId = new Map<string, T>();
	for (const item of local) byId.set(item.id, item);
	for (const item of remote) {
		const existing = byId.get(item.id);
		if (!existing || item.updated > existing.updated) byId.set(item.id, item);
	}
	return [...byId.values()];
}
