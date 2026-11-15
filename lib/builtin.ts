// The on-device AI voice: generated inside the browser (a Web Worker), so it works
// without the server and without a connection once downloaded. It comes in three
// sizes ("powers") so everyone can pick the one their device can carry:
//   light    – Piper voice, ~63 MB: phones, tablets and older computers
//   balanced – the studio voice compressed (Kokoro q8), ~92 MB: recent computers
//   best     – the full studio voice (Kokoro fp32), ~326 MB: powerful computers,
//              on the graphics chip (WebGPU) when there is one
import type { VoiceOption } from "./types";
import { STUDIO_VOICES } from "./voices";

export type Tier = "light" | "balanced" | "best";
export const TIER_ORDER: Tier[] = ["light", "balanced", "best"];

export const TIERS: Record<Tier, { name: string; mb: number; blurb: string }> = {
  light: { name: "Light", mb: 63, blurb: "Runs smoothly on phones, tablets and older computers. Clear and pleasant, a little less natural." },
  balanced: { name: "Balanced", mb: 92, blurb: "The studio voice, compressed. Natural and warm. For recent computers." },
  best: { name: "Best", mb: 326, blurb: "The full studio voice, the same quality as the server. For powerful computers; uses the graphics chip when there is one." },
};

/** Light voices (Piper). Each is its own download of about 63 MB. */
export const PIPER_VOICES: VoiceOption[] = [
  { id: "en_US-lessac-medium", name: "Lessac · clear, American", gender: "female", useCase: "narration" },
  { id: "en_US-ryan-medium", name: "Ryan · American", gender: "male" },
  { id: "en_GB-alba-medium", name: "Alba · Scottish", gender: "female" },
  { id: "en_GB-alan-medium", name: "Alan · British", gender: "male" },
];

export type DeviceKind = "auto" | "phone-old" | "phone-new" | "computer-basic" | "computer-good" | "computer-strong";

export const DEVICE_KINDS: { id: DeviceKind; label: string }[] = [
  { id: "auto", label: "Detect it for me" },
  { id: "phone-old", label: "Phone or tablet, from before 2022" },
  { id: "phone-new", label: "Recent phone or tablet (2022 or newer)" },
  { id: "computer-basic", label: "Older or basic computer" },
  { id: "computer-good", label: "Recent computer" },
  { id: "computer-strong", label: "Powerful computer (gaming, Apple M chip, graphics card)" },
];

export interface DeviceCheck {
  mobile: boolean;
  memoryGb: number | null;
  cores: number;
  gpu: boolean;
  /** Higher is faster: a short calculation test, ~100 on a recent laptop. */
  speed: number;
  kind: Exclude<DeviceKind, "auto">;
  summary: string;
}

const isMobile = () => {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
};

function benchmark(): number {
  // About 30–60 ms on a recent laptop: float math similar to what the voice model does.
  const n = 1 << 16;
  const a = new Float32Array(n).map((_, i) => Math.sin(i));
  const b = new Float32Array(n).map((_, i) => Math.cos(i));
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const t0 = performance.now();
    let acc = 0;
    for (let k = 0; k < 40; k++) for (let i = 0; i < n; i++) acc += a[i] * b[(i + k) & (n - 1)];
    best = Math.min(best, performance.now() - t0);
    if (acc === 42) console.log(acc); // keeps the loop from being optimised away
  }
  return Math.round((40 / Math.max(1, best)) * 100);
}

/** Feel out what this device can carry. */
export async function checkDevice(): Promise<DeviceCheck> {
  const mobile = isMobile();
  const memoryGb = (navigator as { deviceMemory?: number }).deviceMemory ?? null;
  const cores = navigator.hardwareConcurrency || 2;
  let gpu = false;
  try {
    const g = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    gpu = !!(g && (await g.requestAdapter()));
  } catch {}
  const speed = benchmark();
  let kind: DeviceCheck["kind"];
  if (mobile) kind = speed >= 70 ? "phone-new" : "phone-old";
  else if ((memoryGb !== null && memoryGb < 4) || speed < 45 || cores <= 2) kind = "computer-basic";
  else if ((memoryGb === null || memoryGb >= 8) && cores >= 8 && speed >= 90) kind = "computer-strong";
  else kind = "computer-good";
  const parts = [mobile ? "phone or tablet" : "computer", `${cores} processor cores`];
  if (memoryGb) parts.push(`${memoryGb >= 8 ? "8+" : memoryGb} GB memory`);
  parts.push(gpu ? "graphics chip available" : "no graphics chip access");
  parts.push(speed >= 90 ? "fast" : speed >= 50 ? "medium speed" : "slow");
  return { mobile, memoryGb, cores, gpu, speed, kind, summary: parts.join(" · ") };
}

export interface TierAdvice {
  recommended: Tier;
  /** Why a size can't be chosen on this device (absent = can be chosen). */
  blocked: Partial<Record<Tier, string>>;
  /** A caution shown next to a size that can be chosen but may struggle. */
  caution: Partial<Record<Tier, string>>;
}

export function adviceFor(kind: Exclude<DeviceKind, "auto">, mobile: boolean): TierAdvice {
  const phoneBlock = "Too heavy for phones and tablets: the page would close.";
  if (mobile || kind === "phone-old" || kind === "phone-new") {
    if (kind === "phone-new" && mobile)
      return {
        recommended: "light",
        blocked: { best: phoneBlock },
        caution: { balanced: "Experimental on phones. If the page closes, the app goes back to Light by itself." },
      };
    return { recommended: "light", blocked: { balanced: phoneBlock, best: phoneBlock }, caution: {} };
  }
  if (kind === "computer-basic") return { recommended: "light", blocked: {}, caution: { balanced: "May be slow on this computer.", best: "Probably too slow on this computer." } };
  if (kind === "computer-good") return { recommended: "balanced", blocked: {}, caution: { best: "May be slow without a strong graphics chip." } };
  return { recommended: "best", blocked: {}, caution: {} };
}

/** The on-device voice can run in this browser at all. */
export function builtinSupported(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined" && typeof WebAssembly === "object";
}

const TIER_KEY = "vb:builtin-tier";
const DEVICE_KEY = "vb:device-kind";
const LOADING_KEY = "vb:builtin-loading";
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

export class BuiltinVoices {
  tier: Tier;
  device: DeviceKind;
  check: DeviceCheck | null = null;
  /** null = not started, 0–1 = downloading, 1 = downloaded */
  progress: number | null = null;
  ready = false;
  /** Sizes whose voice is already stored on this device. */
  stored = new Set<Tier>();
  /** "webgpu" when the Best size runs on the graphics chip. */
  runsOn: string | null = null;
  notice: string | null = null;
  private worker: Worker | null = null;
  private loadedVoice = "";
  private pending = new Map<number, { resolve: (audio: Blob) => void; reject: (e: Error) => void }>();
  private seq = 0;

  constructor(private onChange: () => void) {
    const saved = read(TIER_KEY) as Tier | null;
    this.device = (read(DEVICE_KEY) as DeviceKind | null) ?? "auto";
    this.tier = saved && TIER_ORDER.includes(saved) ? saved : isMobile() ? "light" : "balanced";
    // A size that was loading when the page last died on a phone: it was too heavy.
    const crashed = read(LOADING_KEY) as Tier | null;
    if (crashed && crashed !== "light" && isMobile()) {
      this.tier = "light";
      write(TIER_KEY, "light");
      this.notice = `The ${TIERS[crashed].name} voice was too heavy for this device and the page closed, so the Light voice is used instead.`;
    }
    write(LOADING_KEY, null);
    void this.refreshStored();
  }

  get voices(): VoiceOption[] {
    return this.tier === "light" ? PIPER_VOICES : STUDIO_VOICES;
  }

  /** A voice of the current size for any voice id (e.g. the studio voice's when it stands in). */
  voiceFor(id: string | undefined): string {
    const list = this.voices;
    if (id && list.some((v) => v.id === id)) return id;
    const gender = STUDIO_VOICES.find((v) => v.id === id)?.gender ?? PIPER_VOICES.find((v) => v.id === id)?.gender;
    const british = !!id && /^b[fm]_|en_GB/.test(id);
    const match =
      list.find((v) => v.gender === gender && /^b[fm]_|en_GB/.test(v.id) === british) ?? list.find((v) => v.gender === gender) ?? list[0];
    return match.id;
  }

  /** Its voice is on this device already (no download needed). */
  get available(): boolean {
    return this.ready || this.stored.has(this.tier);
  }

  async refreshStored() {
    try {
      const has = new Set<Tier>();
      const piper = await caches.open("voicebook-voices");
      for (const req of await piper.keys()) if (/\.onnx$/.test(req.url)) has.add("light");
      const hf = await caches.open("transformers-cache");
      for (const req of await hf.keys()) {
        if (/onnx\/model_quantized\.onnx$/.test(req.url)) has.add("balanced");
        if (/onnx\/model\.onnx$/.test(req.url)) has.add("best");
      }
      this.stored = has;
      this.onChange();
    } catch {}
  }

  async runCheck() {
    this.check = await checkDevice();
    this.onChange();
    return this.check;
  }

  get kind(): Exclude<DeviceKind, "auto"> {
    if (this.device !== "auto") return this.device;
    return this.check?.kind ?? (isMobile() ? "phone-old" : "computer-good");
  }

  get advice(): TierAdvice {
    return adviceFor(this.kind, this.check?.mobile ?? isMobile());
  }

  setDevice(kind: DeviceKind) {
    this.device = kind;
    write(DEVICE_KEY, kind);
    this.onChange();
  }

  setTier(tier: Tier) {
    if (tier === this.tier) return;
    this.stop(new Error("the voice size was changed"));
    this.tier = tier;
    this.notice = null;
    write(TIER_KEY, tier);
    this.onChange();
  }

  /** Remove every downloaded on-device voice from this device. */
  async deleteDownloads() {
    this.stop(new Error("the voices were deleted"));
    await Promise.all([caches.delete("voicebook-voices"), caches.delete("transformers-cache")]).catch(() => {});
    await this.refreshStored();
  }

  private stop(err: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.progress = null;
    this.runsOn = null;
    this.loadedVoice = "";
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }

  private start() {
    if (this.worker) return this.worker;
    const url = this.tier === "light" ? "/voice/piper.worker.js" : `/voice/kokoro.worker.js?tier=${this.tier}`;
    const w = new Worker(url, { type: "module" });
    const tier = this.tier;
    this.progress = this.stored.has(tier) ? 1 : 0;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "progress") {
        this.progress = Math.max(this.progress ?? 0, m.progress);
        return this.onChange();
      }
      if (m.type === "ready") {
        this.ready = true;
        this.progress = 1;
        this.runsOn = m.device ?? null;
        this.stored.add(tier);
        return this.onChange();
      }
      if (m.type === "error") {
        write(LOADING_KEY, null);
        this.progress = null;
        this.notice = `The ${TIERS[tier].name} voice couldn't load: ${m.error}`;
        this.pending.forEach((p) => p.reject(new Error(`the voice couldn't load on this device: ${m.error}`)));
        this.pending.clear();
        return this.onChange();
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`could not make the voice on this device: ${m.error}`));
      else {
        write(LOADING_KEY, null); // it worked: this size is fine here
        p.resolve(new Blob([m.buffer], { type: "audio/wav" }));
      }
    };
    w.onerror = () => {
      write(LOADING_KEY, null);
      this.stop(new Error("the voice could not load on this device"));
      this.onChange();
    };
    this.worker = w;
    return w;
  }

  /** Start getting the voice ready (download if needed) in the background. */
  warm(voice?: string) {
    const v = this.voiceFor(voice);
    if (this.worker && (this.tier !== "light" || this.loadedVoice === v)) return;
    if (this.tier === "light" && this.loadedVoice && this.loadedVoice !== v) {
      this.ready = false;
      this.progress = 0;
    }
    if (!this.stored.has(this.tier)) write(LOADING_KEY, this.tier);
    this.loadedVoice = v;
    this.start().postMessage({ type: "load", voice: v });
    this.onChange();
  }

  generate(text: string, voice: string, speed: number): Promise<Blob> {
    const id = ++this.seq;
    const v = this.voiceFor(voice);
    if (this.tier === "light" && this.loadedVoice !== v) {
      // A different light voice is its own download.
      this.ready = false;
      this.progress = 0;
      this.loadedVoice = v;
    }
    if (!this.worker && !this.stored.has(this.tier)) write(LOADING_KEY, this.tier);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.start().postMessage({ id, text, voice: v, speed });
    });
  }
}
