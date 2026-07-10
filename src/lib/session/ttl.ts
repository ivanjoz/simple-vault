// The 40-second lifetime for any decrypted entry secret (PLAN.md §5.3).

export const SECRET_TTL_MS = 40_000;

export interface Cancellable {
	cancel(): void;
}

/** Run `onExpire` after `ms`, unless cancelled first. */
export function expireAfter(ms: number, onExpire: () => void): Cancellable {
	const timer = setTimeout(onExpire, ms);
	return { cancel: () => clearTimeout(timer) };
}
