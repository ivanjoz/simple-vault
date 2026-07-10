// Worker entry point. Owns a single KeyEngine for the worker's lifetime.
// Supports both SharedWorker (survives page reloads while a tab stays open) and
// dedicated Worker (fallback). Thin transport only.

import { KeyEngine } from './keyEngine.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

const engine = new KeyEngine();

function process(data: WorkerRequest, post: (message: WorkerResponse) => void): void {
	const { id, op, payload } = data;
	engine
		.handle(op, payload)
		.then((result) => post({ id, ok: true, result } as WorkerResponse))
		.catch((err: unknown) => {
			post({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
		});
}

interface Port {
	onmessage: ((event: { data: WorkerRequest }) => void) | null;
	postMessage(message: WorkerResponse): void;
	start?(): void;
}
interface WorkerScope {
	onmessage: ((event: { data: WorkerRequest }) => void) | null;
	onconnect: ((event: { ports: Port[] }) => void) | null;
	postMessage(message: WorkerResponse): void;
}

const scope = self as unknown as WorkerScope;

if ('onconnect' in self) {
	// SharedWorker: one KeyEngine shared across all connected tabs.
	scope.onconnect = (event) => {
		const port = event.ports[0];
		port.onmessage = (event) => process(event.data, (message) => port.postMessage(message));
		port.start?.();
	};
} else {
	// Dedicated Worker.
	scope.onmessage = (event) => process(event.data, (message) => scope.postMessage(message));
}
