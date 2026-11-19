// Voicebook offline support. The app itself (page, code, styles, voice engines) is
// kept on the device so it opens and reads without a connection. Books, saved audio
// and downloaded voices are already stored by the app (IndexedDB / Cache API).
//
// On hosts that can't send custom headers (GitHub Pages), this worker also adds the two
// headers that let the on-device voices use several processor cores (cross-origin isolation).
const VERSION = "vb-app-v3";
const BASE = new URL("./", self.location).pathname.replace(/\/$/, ""); // "" or "/voicebook"
const at = (p) => BASE + p;
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/pdf.worker.min.mjs",
  "/voice/piper.worker.js", "/voice/piper/ort.wasm.min.mjs", "/voice/piper/ort-wasm-simd-threaded.mjs",
  "/voice/piper/ort-wasm-simd-threaded.wasm", "/voice/piper/phonemizer.js"].map(at);

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

/** Same response, with the isolation headers (only where the host didn't send them). */
function isolated(res) {
  if (!res || res.status === 0 || res.type === "opaque" || res.headers.get("Cross-Origin-Embedder-Policy")) return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // voice servers, Hugging Face: untouched
  if (url.pathname.includes("/api/") || url.pathname.startsWith("/__native/") || url.pathname.startsWith(at("/download/"))) return;

  // Pages: the newest version when online, the kept one when offline.
  if (req.mode === "navigate") {
    const home = at("/");
    event.respondWith(
      (async () => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          const isHome = url.pathname === home || url.pathname === BASE;
          const res = await fromNetwork(isHome ? new Request(home, { signal: ctrl.signal }) : req, isHome ? home : undefined);
          clearTimeout(timer);
          return isolated(res);
        } catch {
          return isolated((await caches.match(home)) ?? new Response("Offline", { status: 503 }));
        }
      })(),
    );
    return;
  }

  // Built files have unique names: once kept, they never change.
  if (url.pathname.startsWith(at("/_next/static/")) || url.pathname.startsWith(at("/icons/"))) {
    event.respondWith(caches.match(req).then((hit) => hit ?? fromNetwork(req)).then(isolated));
    return;
  }

  // Everything else (voice engines, pdf reader…): kept copy at once, refreshed in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const live = fromNetwork(req).catch(() => hit ?? Response.error());
      return (hit ? Promise.resolve(hit) : live).then(isolated);
    }),
  );
});
