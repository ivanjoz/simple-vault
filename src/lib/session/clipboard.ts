// One-click copy with best-effort auto-clear (PLAN.md §5.3 / §8.2).
//
// After the TTL elapses the clipboard is overwritten. This is best-effort: a
// browser may reject a clipboard write when the tab is not focused.

import { SECRET_TTL_MS, expireAfter, type Cancellable } from './ttl.ts';

export type ClipboardWriter = (text: string) => Promise<void>;

const defaultWriter: ClipboardWriter = (text) => navigator.clipboard.writeText(text);

export interface CopyHandle extends Cancellable {
	/** Resolves once the initial copy has been written. */
	written: Promise<void>;
}

/**
 * Copy `text` to the clipboard and schedule it to be cleared after `ttlMs`.
 * The `write` port is injectable for testing.
 */
export function copyWithAutoClear(
	text: string,
	ttlMs = SECRET_TTL_MS,
	write: ClipboardWriter = defaultWriter
): CopyHandle {
	const written = write(text);
	const timer = expireAfter(ttlMs, () => {
		void write('').catch(() => {
			/* best-effort: ignore if the tab lost focus */
		});
	});
	return {
		written,
		cancel: () => timer.cancel()
	};
}
