// Pure delta / merge helpers for synchronization (PLAN.md §6). No I/O, no crypto
// — kept side-effect-free so the conflict logic is directly unit-testable.

interface Versioned {
	id: string;
	updated: number;
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
