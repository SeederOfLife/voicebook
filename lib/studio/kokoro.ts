// The studio voice: the Kokoro-82M neural voice model, run on the server with
// ONNX Runtime. Full-precision weights (the best-sounding variant) are fetched
// once per server instance and kept in the temp folder.
//
// Server-only module (uses the file system and a native runtime).
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { phonemize } from "./phonemize";
import { VOCAB } from "./vocab";

export const SAMPLE_RATE = 24000;
const STYLE_DIM = 256;
/** The model's context is 512 tokens including the two padding tokens. */
const MAX_TOKENS = 510;
/** Batches are kept a little under the limit: very long batches tend to rush. */
const BATCH_TOKENS = 400;

const GAIN = 1.25;
const KNEE = 0.8;

const SENTENCE_PAUSE = 0.3;
const CLAUSE_PAUSE = 0.12;
const PARAGRAPH_PAUSE = 0.65;

type Variant = "fp32" | "q8";

const VARIANTS: Record<Variant, { file: string; bytes: number; urls: string[] }> = {
  // Full precision: the reference quality.
  fp32: {
    file: "kokoro-v1.0-fp32.onnx",
    bytes: 325_532_387,
    urls: [
      "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
    ],
  },
  // 8-bit: a quarter of the size, slightly less clean. Only used when memory is short.
  q8: {
    file: "kokoro-v1.0-q8.onnx",
    bytes: 92_361_271,
    urls: [
      "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx",
      "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx",
    ],
  },
};

export interface StudioStatus {
  state: "idle" | "downloading" | "loading" | "ready" | "error";
  /** 0–1 while the voice model downloads */
  progress: number;
  variant: Variant | null;
  error: string | null;
  threads: number;
  memoryMb: number;
  loadSeconds: number | null;
  /** generation time ÷ audio time of the last passage (below 1 = faster than real time) */
  lastSpeed: number | null;
}

const status: StudioStatus = {
  state: "idle",
  progress: 0,
  variant: null,
  error: null,
  threads: 0,
  memoryMb: 0,
  loadSeconds: null,
  lastSpeed: null,
};

export function studioStatus(): StudioStatus {
  return { ...status, memoryMb: Math.round(process.memoryUsage().rss / 1048576) };
}

function availableMemoryMb(): number {
  const lambda = Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
  return lambda > 0 ? lambda : os.totalmem() / 1048576;
}

function preferredVariants(): Variant[] {
  const forced = process.env.KOKORO_MODEL;
  if (forced === "fp32" || forced === "q8") return [forced];
  return availableMemoryMb() >= 1700 ? ["fp32", "q8"] : ["q8"];
}

// The model lives in the server's temp folder (not part of the deployed files).
const modelDir = () => path.join(/*turbopackIgnore: true*/ process.env.KOKORO_MODEL_DIR || os.tmpdir(), "voicebook-voice");

async function download(variant: Variant): Promise<string> {
  const spec = VARIANTS[variant];
  const dir = modelDir();
  const target = path.join(/*turbopackIgnore: true*/ dir, spec.file);
  // A file only gets its final name after a complete download, so a plausible size is enough here.
  const plausible = (bytes: number) => bytes > spec.bytes * 0.95 && bytes < spec.bytes * 1.05;
  const sizeOf = async (p: string) => {
    try {
      return (await stat(/*turbopackIgnore: true*/ p)).size;
    } catch {
      return 0;
    }
  };
  if (plausible(await sizeOf(target))) return target;
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  // The temp folder is small (500 MB on Vercel): clear what an interrupted download left behind.
  for (const name of await readdir(/*turbopackIgnore: true*/ dir).catch(() => [] as string[])) {
    if (!name.endsWith(".part")) continue;
    const old = path.join(/*turbopackIgnore: true*/ dir, name);
    const age = Date.now() - (await stat(/*turbopackIgnore: true*/ old).then((x) => x.mtimeMs).catch(() => Date.now()));
    if (age > 5 * 60_000) await unlink(/*turbopackIgnore: true*/ old).catch(() => {});
  }

  let lastError: unknown = new Error("no source");
  for (const url of spec.urls) {
    const part = `${target}.${process.pid}.${Date.now()}.part`;
    try {
      status.state = "downloading";
      status.progress = 0;
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      const announced = Number(res.headers.get("content-length")) || 0;
      const total = announced || spec.bytes;
      let got = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on("data", (chunk: Buffer) => {
        got += chunk.length;
        status.progress = Math.min(0.999, got / total);
      });
      await pipeline(body, createWriteStream(/*turbopackIgnore: true*/ part));
      const size = await sizeOf(part);
      if (!plausible(size) || (announced && size !== announced)) {
        throw new Error(`incomplete download from ${new URL(url).host} (${size} of ${announced || spec.bytes} bytes)`);
      }
      await rename(/*turbopackIgnore: true*/ part, /*turbopackIgnore: true*/ target);
      status.progress = 1;
      return target;
    } catch (e) {
      lastError = e;
      await unlink(/*turbopackIgnore: true*/ part).catch(() => {});
    }
  }
  throw new Error(`Could not download the voice model: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

interface Engine {
  session: InferenceSession;
  ort: typeof import("onnxruntime-node");
  idsInput: string;
}

let enginePromise: Promise<Engine> | null = null;

async function createEngine(): Promise<Engine> {
  const started = Date.now();
  const mod = await import("onnxruntime-node");
  const ort = ((mod as { default?: unknown }).default ?? mod) as typeof import("onnxruntime-node");
  const threads = Math.max(1, Math.min(4, Number(process.env.KOKORO_THREADS) || os.availableParallelism()));
  status.threads = threads;

  let lastError: unknown;
  const local = process.env.KOKORO_MODEL_PATH;
  const candidates: { variant: Variant; file?: string }[] =
    local && existsSync(/*turbopackIgnore: true*/ local)
      ? [{ variant: /int8|q8|quant/i.test(local) ? "q8" : "fp32", file: local }]
      : preferredVariants().map((variant) => ({ variant }));

  for (const c of candidates) {
    try {
      status.variant = c.variant;
      status.error = null;
      const file = c.file ?? (await download(c.variant));
      status.state = "loading";
      const session = await ort.InferenceSession.create(file, {
        executionProviders: ["cpu"],
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        executionMode: "sequential",
        graphOptimizationLevel: "all",
      });
      const idsInput = session.inputNames.includes("input_ids") ? "input_ids" : session.inputNames.includes("tokens") ? "tokens" : session.inputNames[0];
      status.state = "ready";
      status.progress = 1;
      status.loadSeconds = (Date.now() - started) / 1000;
      return { session, ort, idsInput };
    } catch (e) {
      lastError = e;
      console.error(`[studio voice] ${c.variant} failed:`, e);
      // A damaged download must not be reused on the next try.
      if (!c.file) await unlink(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ modelDir(), VARIANTS[c.variant].file)).catch(() => {});
    }
  }
  status.state = "error";
  status.error = lastError instanceof Error ? lastError.message : String(lastError);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Load the voice model (once per server instance). Safe to call many times. */
export function warmUp(): Promise<void> {
  enginePromise ??= createEngine();
  enginePromise.catch(() => (enginePromise = null));
  return enginePromise.then(() => undefined);
}

// ---------- voices ----------

const VOICE_ID = /^[ab][fm]_[a-z]+$/;
const voiceCache = new Map<string, Float32Array>();

async function loadVoice(id: string): Promise<Float32Array> {
  if (!VOICE_ID.test(id)) throw new Error(`Unknown voice "${id}"`);
  const cached = voiceCache.get(id);
  if (cached) return cached;
  try {
    // The voice files ship with the kokoro-js package (see next.config.mjs for the tracing rules).
    const buf = await readFile(path.join(process.cwd(), "node_modules", "kokoro-js", "voices", `${id}.bin`));
    const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    voiceCache.set(id, data);
    return data;
  } catch {
    throw new Error(`Voice "${id}" is not installed on the server`);
  }
}

// ---------- text → batches ----------

const SENTENCE_MARKS = ".!?…";
const CLAUSE_MARKS = ",;:—";
const BOUNDARIES = [/(?<=[.!?…]["”»)]?)\s+/, /(?<=[,;:—])\s+/, /\s+/];

/** Pieces of `phonemes`, each no longer than `max`, cut at the gentlest boundary available. */
function atoms(phonemes: string, max: number, level = 0): string[] {
  if (phonemes.length <= max) return phonemes ? [phonemes] : [];
  for (let i = level; i < BOUNDARIES.length; i++) {
    const pieces = phonemes.split(BOUNDARIES[i]);
    if (pieces.length > 1) return pieces.flatMap((p) => atoms(p.trim(), max, i + 1));
  }
  const out: string[] = [];
  for (let s = 0; s < phonemes.length; s += max) out.push(phonemes.slice(s, s + max));
  return out;
}

function pack(lengths: number[], limit: number): [number, number][] {
  const batches: [number, number][] = [];
  let start = 0;
  let size = 0;
  lengths.forEach((length, index) => {
    const candidate = index === start ? length : size + 1 + length;
    if (candidate > limit && index > start) {
      batches.push([start, index]);
      start = index;
      size = length;
    } else size = candidate;
  });
  if (lengths.length) batches.push([start, lengths.length]);
  return batches;
}

/**
 * Split phonemes into evenly sized batches. A short left-over batch is spoken at a
 * different pace and loudness than its neighbours, so batches are balanced.
 */
export function splitPhonemes(phonemes: string, max = BATCH_TOKENS): string[] {
  const parts = atoms(phonemes.trim(), Math.min(max, MAX_TOKENS));
  if (!parts.length) return [];
  const lengths = parts.map((p) => p.length);
  const fewest = pack(lengths, max).length;
  let low = Math.max(...lengths);
  let high = max;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (pack(lengths, middle).length <= fewest) high = middle;
    else low = middle + 1;
  }
  return pack(lengths, low).map(([s, e]) => parts.slice(s, e).join(" "));
}

function pauseAfter(phonemes: string): number {
  const mark = phonemes.replace(/["”»)\s]+$/, "").slice(-1);
  if (SENTENCE_MARKS.includes(mark)) return SENTENCE_PAUSE;
  if (CLAUSE_MARKS.includes(mark)) return CLAUSE_PAUSE;
  return 0.06;
}

// ---------- audio helpers ----------

/** Remove the silence the model leaves at both ends, keeping a short natural margin. */
function trimSilence(audio: Float32Array): Float32Array {
  const frame = 960; // 40 ms
  const hop = 240; // 10 ms
  if (audio.length < frame * 2) return audio;
  const energies: number[] = [];
  let loudest = 0;
  for (let s = 0; s + frame <= audio.length; s += hop) {
    let sum = 0;
    for (let i = s; i < s + frame; i++) sum += audio[i] * audio[i];
    const rms = Math.sqrt(sum / frame);
    energies.push(rms);
    if (rms > loudest) loudest = rms;
  }
  if (loudest < 1e-5) return audio.subarray(0, 0);
  const threshold = loudest * Math.pow(10, -52 / 20);
  let first = 0;
  while (first < energies.length && energies[first] < threshold) first++;
  let last = energies.length - 1;
  while (last > first && energies[last] < threshold) last--;
  const start = Math.max(0, first * hop - Math.round(0.02 * SAMPLE_RATE));
  const end = Math.min(audio.length, last * hop + frame + Math.round(0.07 * SAMPLE_RATE));
  const out = audio.slice(start, end);
  const fade = Math.min(Math.round(0.006 * SAMPLE_RATE), out.length >> 1);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[out.length - 1 - i] *= i / fade;
  }
  return out;
}

// ---------- synthesis ----------

let queue: Promise<unknown> = Promise.resolve();
/** One passage at a time per server instance: the model already uses every core. */
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

export interface SynthesisResult {
  audio: Float32Array;
  seconds: number;
  /** seconds of computing it took */
  took: number;
  batches: number;
}

export interface SynthesisOptions {
  voice?: string;
  /** 0.7 – 1.3 */
  speed?: number;
  /** silence appended after the passage, in milliseconds */
  tailMs?: number;
}

export async function synthesize(text: string, opts: SynthesisOptions = {}): Promise<SynthesisResult> {
  const voice = opts.voice && VOICE_ID.test(opts.voice) ? opts.voice : "af_heart";
  const speed = Math.min(1.3, Math.max(0.7, opts.speed || 1));
  const tail = Math.min(3, Math.max(0, (opts.tailMs ?? 300) / 1000));
  const language = voice[0] === "b" ? "b" : "a";

  await warmUp();
  const engine = await enginePromise!;
  const style = await loadVoice(voice);

  // Phonemize paragraph by paragraph so paragraph breaks get a real pause.
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const plan: { phonemes: string; pause: number }[] = [];
  for (let p = 0; p < paragraphs.length; p++) {
    const raw = (await phonemize(paragraphs[p], language)).split(/\s+/).join(" ");
    const phonemes = [...raw].filter((ch) => ch in VOCAB).join("");
    const batches = splitPhonemes(phonemes);
    batches.forEach((b, i) =>
      plan.push({ phonemes: b, pause: i < batches.length - 1 ? pauseAfter(b) : PARAGRAPH_PAUSE }),
    );
  }

  return serial(async () => {
    const started = Date.now();
    const parts: Float32Array[] = [new Float32Array(Math.round(0.03 * SAMPLE_RATE))];
    for (let b = 0; b < plan.length; b++) {
      const { phonemes, pause } = plan[b];
      const ids = [0, ...[...phonemes].map((ch) => VOCAB[ch]).slice(0, MAX_TOKENS), 0];
      const tokens = ids.length - 2;
      const row = Math.min(Math.max(tokens, 0), 509) * STYLE_DIM;
      const feeds: Record<string, Tensor> = {
        [engine.idsInput]: new engine.ort.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, ids.length]),
        style: new engine.ort.Tensor("float32", style.slice(row, row + STYLE_DIM), [1, STYLE_DIM]),
        speed: new engine.ort.Tensor("float32", new Float32Array([speed]), [1]),
      };
      const output = await engine.session.run(feeds);
      const wave = output[engine.session.outputNames[0]].data as Float32Array;
      const trimmed = trimSilence(wave);
      if (trimmed.length) parts.push(trimmed);
      const gap = b === plan.length - 1 ? tail : pause;
      parts.push(new Float32Array(Math.round(gap * SAMPLE_RATE)));
    }
    if (!plan.length) parts.push(new Float32Array(Math.round(Math.max(0.15, tail) * SAMPLE_RATE)));

    const total = parts.reduce((n, p) => n + p.length, 0);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const p of parts) {
      audio.set(p, offset);
      offset += p.length;
    }
    // The model speaks a little quietly for phone speakers: raise the level, rounding
    // off the rare peak instead of clipping it.
    for (let i = 0; i < audio.length; i++) {
      const x = audio[i] * GAIN;
      const a = Math.abs(x);
      audio[i] = a <= KNEE ? x : Math.sign(x) * (KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE)));
    }
    const seconds = total / SAMPLE_RATE;
    const took = (Date.now() - started) / 1000;
    if (seconds > 1) status.lastSpeed = Math.round((took / seconds) * 100) / 100;
    return { audio, seconds, took, batches: plan.length };
  });
}
