/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Offline app shell for the PWA. The vault's data lives in IndexedDB and the
// DEK in the key Worker, so once this shell is cached the whole app works
// offline — we only cache same-origin static assets here. Google Drive / OAuth
// requests are always left to the network (see the origin guard in `fetch`);
// we never want to cache access tokens or the encrypted vault file.

import { build, files, prerendered, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `simple-vault-${version}`;

// `build` = hashed JS/CSS/worker chunks (immutable), `files` = everything in
// static/ (icons, manifest, robots…), `prerendered` = the SPA shell (`/`).
const PRECACHE = [...build, ...files, ...prerendered];
const PRECACHE_SET = new Set(PRECACHE);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			// Add each asset independently: `cache.addAll` is atomic, so a single
			// missing file (e.g. a host-specific dotfile) would abort the whole
			// precache and leave the app with no offline shell. Tolerate per-asset
			// failures instead so the shell and app chunks still get cached.
			const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
			const failed = results.filter((r) => r.status === 'rejected').length;
			if (failed) console.warn(`[sw] ${failed}/${PRECACHE.length} assets failed to precache`);
			// Take over as soon as installed so the new version serves this load.
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Drop caches from previous versions.
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Never intercept cross-origin traffic: Google Drive API, OAuth token
	// endpoint and the GIS script must always go straight to the network.
	if (url.origin !== sw.location.origin) return;

	event.respondWith(handle(request, url));
});

async function handle(request: Request, url: URL): Promise<Response> {
	const cache = await caches.open(CACHE);

	// Hashed build assets and static files are immutable — serve from cache.
	if (PRECACHE_SET.has(url.pathname)) {
		const cached = await cache.match(url.pathname);
		if (cached) return cached;
	}

	// Everything else (navigations, uncached same-origin GETs): try the network
	// first so updates are picked up, then fall back to cache when offline.
	try {
		const response = await fetch(request);
		// Cache successful basic responses for later offline use.
		if (response.ok && response.type === 'basic') {
			cache.put(request, response.clone());
		}
		return response;
	} catch (err) {
		const cached = await cache.match(request);
		if (cached) return cached;
		// SPA fallback: serve the cached app shell for offline navigations.
		if (request.mode === 'navigate') {
			const shell = (await cache.match('/')) ?? (await cache.match('/index.html'));
			if (shell) return shell;
		}
		throw err;
	}
}
