// Voicebook offline support. The app itself (page, code, styles, voice engines) is
// kept on the device so it opens and reads without a connection. Books, saved audio
// and downloaded voices are already stored by the app (IndexedDB / Cache API).
const VERSION = "vb-app-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/pdf.worker.min.mjs",
  "/voice/piper.worker.js", "/voice/piper/ort.wasm.min.mjs", "/voice/piper/ort-wasm-simd-threaded.mjs",
  "/voice/piper/ort-wasm-simd-threaded.wasm", "/voice/piper/phonemizer.js"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})))),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("vb-app-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

async function fromNetwork(req, cacheKey) {
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const copy = res.clone();
    caches.open(VERSION).then((c) => c.put(cacheKey ?? req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // voices from Hugging Face: handled by the app
  if (url.pathname.startsWith("/api/")) return; // always live

  // Pages: the newest version when online, the kept one when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          const res = await fromNetwork(url.pathname === "/" ? new Request("/", { signal: ctrl.signal }) : req, url.pathname === "/" ? "/" : undefined);
          clearTimeout(timer);
          return res;
        } catch {
          return (await caches.match("/")) ?? new Response("Offline", { status: 503 });
        }
      })(),
    );
    return;
  }

  // Built files have unique names: once kept, they never change.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(caches.match(req).then((hit) => hit ?? fromNetwork(req)));
    return;
  }

  // Everything else (voice engines, pdf reader…): kept copy at once, refreshed in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const live = fromNetwork(req).catch(() => hit ?? Response.error());
      return hit ?? live;
    }),
  );
});
