// Main-thread client for the key Worker. Prefers a SharedWorker so the unlocked
// DEK survives page reloads (while any tab stays open); falls back to a
// dedicated Worker where SharedWorker is unavailable. Browser-only.

import type { KeyOp, KeyOps, WorkerRequest, WorkerResponse } from './protocol.ts';

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void };

export class KeyClient {
	#seq = 0;
	#pending = new Map<number, Pending>();
	#post: (request: WorkerRequest) => void;
	#dispose: () => void;
	/** True when backed by a SharedWorker (DEK persists across reloads). */
	readonly shared: boolean;

	constructor() {
		const receive = (data: WorkerResponse) => this.#receive(data);

		if (typeof SharedWorker !== 'undefined') {
			// NB: the `new URL(...)` must stay inline for Vite to emit the worker.
			const worker = new SharedWorker(new URL('./key-worker.ts', import.meta.url), {
				type: 'module'
			});
			worker.port.addEventListener('message', (e: MessageEvent<WorkerResponse>) => receive(e.data));
			worker.port.start();
			this.#post = (request) => worker.port.postMessage(request);
			this.#dispose = () => worker.port.close();
			this.shared = true;
		} else {
			const worker = new Worker(new URL('./key-worker.ts', import.meta.url), { type: 'module' });
			worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) => receive(e.data));
			this.#post = (request) => worker.postMessage(request);
			this.#dispose = () => worker.terminate();
			this.shared = false;
		}
	}

	call<O extends KeyOp>(op: O, payload: KeyOps[O]['req']): Promise<KeyOps[O]['res']> {
		const id = ++this.#seq;
		const request: WorkerRequest<O> = { id, op, payload };
		return new Promise<KeyOps[O]['res']>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.#post(request);
		});
	}

	dispose(): void {
		this.#dispose();
		this.#pending.clear();
	}

	#receive(res: WorkerResponse): void {
		const pending = this.#pending.get(res.id);
		if (!pending) return;
		this.#pending.delete(res.id);
		if (res.ok) pending.resolve(res.result);
		else pending.reject(new Error(res.error));
	}
}
