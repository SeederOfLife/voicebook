// The "Light" on-device voice: a Piper neural voice (about 63 MB) running inside the
// browser. Small enough for phones and tablets. The runtime and the phonemizer are
// served by this site; the voice itself is downloaded once from Hugging Face and kept
// in the browser's storage (Cache API), so it also works without a connection.
import * as ort from "./piper/ort.wasm.min.mjs";
import { phonemize } from "./piper/phonemizer.js";

const HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const CACHE = "voicebook-voices";
const SENTENCE_PAUSE = 0.3;
const PARAGRAPH_PAUSE = 0.6;

ort.env.wasm.wasmPaths = new URL("./piper/", import.meta.url).href;
// iPhone/iPad (WebKit) can freeze with several cores inside a worker; Android and computers can't.
const apple = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
ort.env.wasm.numThreads = !apple && self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
const stage = (name) => self.postMessage({ type: "stage", stage: name });

/** "en_US-lessac-medium" → its two files on Hugging Face. */
function filesOf(voice) {
  const m = /^(([a-z]{2})_[A-Z]{2})-([a-z_]+)-(low|medium|high)$/.exec(voice);
  if (!m) throw new Error(`unknown voice ${voice}`);
  const base = `${HF}${m[2]}/${m[1]}/${m[3]}/${m[4]}/${voice}`;
  return { model: `${base}.onnx`, config: `${base}.onnx.json` };
}

async function fetchCached(url, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      onProgress?.(1);
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch {}
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress?.(Math.min(0.999, got / total));
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) buf.set(c, o), (o += c.length);
  // Keeping it is best effort: if the browser's storage is full it is simply downloaded again next time.
  if (cache) await cache.put(url, new Response(buf, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  onProgress?.(1);
  return buf;
}

// Several voices stay open at once (narrator + characters), so switching speaker is instant.
const MAX_OPEN = apple ? 2 : 4;
const open = new Map(); // voice → Promise<{ session, config }>, most recently used last
function load(voice) {
  const hit = open.get(voice);
  if (hit) {
    open.delete(voice);
    open.set(voice, hit);
    return hit;
  }
  while (open.size >= MAX_OPEN) {
    const [oldest, p] = open.entries().next().value;
    open.delete(oldest);
    p.then((m) => m.session.release?.()).catch(() => {});
  }
  const promise = (async () => {
    const files = filesOf(voice);
    const config = JSON.parse(new TextDecoder().decode(await fetchCached(files.config)));
    const model = await fetchCached(files.model, (p) => self.postMessage({ type: "progress", progress: p }));
    stage("opening the voice");
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    // Say one word before announcing "ready", so "ready" means it really works here.
    const t0 = performance.now();
    await speak({ session, config }, "Hello.", 1);
    self.postMessage({ type: "ready", device: "wasm", testMs: Math.round(performance.now() - t0) });
    return { session, config };
  })();
  open.set(voice, promise);
  promise.catch(() => open.get(voice) === promise && open.delete(voice));
  return promise;
}

// ---------- text → phonemes → ids ----------

// Punctuation that ends a phrase (followed by a space or the end), so "3.50", "7:05" and "U.S." stay whole.
const PUNCT = /([.,!?;:…—–()]+(?=\s|$)|[—–()]+)/;

function clean(text) {
  return text
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function phonemesOf(text, lang) {
  let out = "";
  for (const part of clean(text).split(PUNCT)) {
    if (!part) continue;
    if (/^[.,!?;:…—–()]+$/.test(part)) {
      out += part.replace(/…/g, "...").replace(/[—–]/g, ",").replace(/[()]/g, ",");
      continue;
    }
    if (!part.trim()) {
      out += " ";
      continue;
    }
    const ph = (await phonemize(part.trim(), lang)).join(" ");
    out += (/^\s/.test(part) ? " " : "") + ph + (/\s$/.test(part) ? " " : "");
  }
  return out.trim();
}

function idsOf(phonemes, map) {
  const pad = map._ ?? [0];
  const ids = [...(map["^"] ?? []), ...pad];
  for (const ch of Array.from(phonemes)) {
    const id = map[ch];
    if (id) ids.push(...id, ...pad);
  }
  ids.push(...(map.$ ?? []));
  return ids;
}

function sentences(paragraph) {
  const found = paragraph.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*\s*|$)/g)?.filter((s) => s.trim()) ?? [paragraph];
  // Very short pieces ("No." "Yes!") sound better joined to the next sentence.
  const out = [];
  for (const s of found) {
    if (out.length && out[out.length - 1].length < 12) out[out.length - 1] += s;
    else out.push(s);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

async function speak(model, text, speed) {
  const { session, config } = model;
  const rate = config.audio?.sample_rate || 22050;
  const lang = config.espeak?.voice || "en-us";
  const inf = config.inference || {};
  const parts = [];
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const list = sentences(paragraphs[pi]);
    for (let si = 0; si < list.length; si++) {
      stage("reading the words");
      const ph = await phonemesOf(list[si], lang);
      const ids = idsOf(ph, config.phoneme_id_map);
      if (ids.length < 4) continue;
      const feeds = {
        input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
        input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor("float32", Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (speed || 1), inf.noise_w ?? 0.8]), [3]),
      };
      if (session.inputNames.includes("sid")) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
      stage("making the sound");
      const result = await session.run(feeds);
      parts.push(result[session.outputNames[0]].data);
      const last = si === list.length - 1;
      if (!(last && pi === paragraphs.length - 1)) parts.push(new Float32Array(Math.round(rate * (last ? PARAGRAPH_PAUSE : SENTENCE_PAUSE))));
    }
  }
  // Even loudness: bring the loudest point to about 0.9 (never more than ×2).
  let peak = 0;
  for (const p of parts) for (let i = 0; i < p.length; i++) peak = Math.max(peak, Math.abs(p[i]));
  const gain = peak > 0 ? Math.min(2, 0.9 / peak) : 1;
  return wav(parts, rate, gain);
}

function wav(chunks, rate, gain) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i] * gain)) * 32767, true);
  return buf;
}

let queue = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "load") return void load(m.voice).catch((e) => self.postMessage({ type: "error", error: String(e?.message ?? e) }));
  queue = queue.then(async () => {
    try {
      self.postMessage({ type: "start", id: m.id });
      const model = await load(m.voice);
      const buffer = await speak(model, m.text, m.speed);
      self.postMessage({ id: m.id, buffer }, [buffer]);
    } catch (e) {
      self.postMessage({ id: m.id, error: String(e?.message ?? e) });
    }
  });
};
