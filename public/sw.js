/**
 * Translate - service worker.
 *
 * Scope is deliberately narrow. This caches the app shell so the PWA opens
 * instantly (and so an installed icon never lands on a blank page), and does
 * nothing else.
 *
 * It must never cache /api/*: a translation is a one-shot paid inference call
 * whose response is specific to one photo. Serving a stale one would show the
 * wrong translation over the right picture.
 *
 * Bump CACHE when shell files change; `activate` deletes every other cache.
 */

const CACHE = "translate-shell-v2";

/** Every module must be listed, or an offline launch stalls on a missing import. */
const SHELL = [
	"/",
	"/styles.css",
	"/icon.svg",
	"/manifest.webmanifest",
	"/icon-192.png",
	"/icon-512.png",
	"/js/main.js",
	"/js/ui.js",
	"/js/camera.js",
	"/js/image.js",
	"/js/api.js",
	"/js/overlay.js",
	"/js/install.js",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			// Individual failures must not abort the whole install.
			.then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	const url = new URL(request.url);

	// Only same-origin GETs are ours to handle.
	if (request.method !== "GET" || url.origin !== self.location.origin) return;

	// Translation and language lookups always go to the network, never the cache.
	if (url.pathname.startsWith("/api/")) return;

	/*
	 * Navigations: network first so a deploy is picked up immediately, falling
	 * back to the cached shell when offline. Without the fallback an installed
	 * PWA opened offline would show the browser's error page.
	 */
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((response) => {
					const copy = response.clone();
					caches.open(CACHE).then((cache) => cache.put("/", copy));
					return response;
				})
				.catch(() => caches.match("/", { ignoreSearch: true })),
		);
		return;
	}

	/*
	 * Static assets: stale-while-revalidate. Serve the cached copy for speed,
	 * refresh it in the background for the next load.
	 */
	event.respondWith(
		caches.match(request).then((cached) => {
			const network = fetch(request)
				.then((response) => {
					if (response && response.status === 200 && response.type === "basic") {
						const copy = response.clone();
						caches.open(CACHE).then((cache) => cache.put(request, copy));
					}
					return response;
				})
				.catch(() => cached);
			return cached || network;
		}),
	);
});
