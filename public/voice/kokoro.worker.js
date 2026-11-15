// On-device studio voice: the Kokoro neural voice model running fully inside the browser.
// Two sizes, chosen in the app: "balanced" (compressed, ~92 MB) and "best" (full
// precision, ~326 MB, the same quality as the server; uses the graphics chip through
// WebGPU when the browser offers it). The code is served by this site; the voice is
// downloaded once from Hugging Face and then kept by the browser.
import { KokoroTTS, env } from "./kokoro.web.js";

env.wasmPaths = new URL("./", import.meta.url).href;
const tier = new URL(self.location.href).searchParams.get("tier") === "best" ? "best" : "balanced";

async function create(device) {
  return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: tier === "best" ? "fp32" : "q8",
    device,
    progress_callback: (p) => {
      if (p.status === "progress" && /\.onnx$/.test(p.file ?? "") && p.total)
        self.postMessage({ type: "progress", progress: p.loaded / p.total });
    },
  });
}

let ttsPromise = null;
function load() {
  ttsPromise ??= (async () => {
    let device = "wasm";
    let tts = null;
    if (tier === "best" && self.navigator?.gpu) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          tts = await create("webgpu");
          await tts.generate("Hi.", { voice: "af_heart" }); // fails here if the graphics chip can't run it
          device = "webgpu";
        }
      } catch {
        tts = null;
      }
    }
    tts ??= await create("wasm");
    self.postMessage({ type: "ready", device });
    return tts;
  })();
  ttsPromise.catch(() => (ttsPromise = null));
  return ttsPromise;
}

// The model reads about a sentence or two at a time; longer text is split and joined.
function split(text, max = 280) {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["”»’)\]]*\s*|$)/g)?.filter((s) => s.trim()) ?? [text];
  const out = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > max) {
      let cut = s.lastIndexOf(", ", max);
      if (cut < max * 0.4) cut = s.lastIndexOf(" ", max);
      if (cut < max * 0.4) cut = max;
      if (cur) out.push(cur), (cur = "");
      out.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if (cur && cur.length + s.length > max) out.push(cur), (cur = "");
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function wav(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 32767, true);
  return buf;
}

let queue = Promise.resolve();
self.onmessage = (ev) => {
  const { id, text, voice, speed } = ev.data;
  if (ev.data.type === "load") return void load().catch((e) => self.postMessage({ type: "error", error: String(e?.message ?? e) }));
  queue = queue.then(async () => {
    try {
      const tts = await load();
      const parts = [];
      let rate = 24000;
      for (const piece of split(text)) {
        const audio = await tts.generate(piece, { voice, speed: speed || 1 });
        rate = audio.sampling_rate;
        parts.push(audio.audio, new Float32Array(Math.round(rate * 0.12)));
      }
      const buffer = wav(parts, rate);
      self.postMessage({ id, buffer }, [buffer]);
    } catch (e) {
      self.postMessage({ id, error: String(e?.message ?? e) });
    }
  });
};
