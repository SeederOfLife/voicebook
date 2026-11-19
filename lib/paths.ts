// Where things live. The same code runs:
//  - as one Next.js app with its server (Vercel, Hugging Face Space): everything on one address;
//  - as a static site on GitHub Pages (under /voicebook/) that calls a voice server elsewhere.

/** Folder the site is published under ("" or "/voicebook"). */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** A file of the site (icons, voice engines, the APK…). */
export const asset = (path: string) => `${BASE}${path}`;

/**
 * Voice/AI servers to try, in order (comma-separated at build time). Empty = the server
 * that serves this page. The first one that answers is used; the choice is remembered.
 */
const SERVERS = (process.env.NEXT_PUBLIC_API_BASES ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

const KEY = "vb:server";
let current = "";
try {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
  current = saved !== null && (SERVERS.includes(saved) || (!SERVERS.length && saved === "")) ? saved : SERVERS[0] ?? "";
} catch {
  current = SERVERS[0] ?? "";
}

/** A server address, e.g. api("/api/voice"). */
export const api = (path: string) => `${current}${path}`;

/** The server in use ("" = this site's own). */
export const serverInUse = () => current || (typeof location !== "undefined" ? location.origin : "");

/** The server answers, but slowly at first (a free server that was asleep wakes up). */
export const separateServer = SERVERS.length > 0;

/**
 * Finds a server that answers /api/config and uses it from now on. Tries the remembered
 * one first. `onWait` is told when it's waiting for a sleeping server to wake up.
 */
export async function findServer<T>(headers: HeadersInit, onWait?: (msg: string) => void): Promise<{ config: T; server: string } | null> {
  const order = SERVERS.length ? [current, ...SERVERS.filter((s) => s !== current)] : [""];
  const attempt = async (server: string, ms: number) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(`${server}/api/config`, { headers, signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  };
  // Quick round first, then a patient one (a free server can take a minute to wake).
  for (const ms of SERVERS.length ? [9000, 75000] : [15000]) {
    for (const server of order) {
      if (ms > 9000) onWait?.("Waking up the voice server (can take a minute)…");
      const config = await attempt(server, ms);
      if (config) {
        current = server;
        try {
          localStorage.setItem(KEY, server);
        } catch {}
        return { config, server };
      }
    }
  }
  return null;
}
