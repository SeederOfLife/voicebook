// Built-in AI voices (Kokoro) running in a Web Worker inside the browser.
import type { VoiceOption } from "./types";

export const BUILTIN_VOICES: VoiceOption[] = [
  { id: "bm_george", name: "George · British", gender: "male", useCase: "narration" },
  { id: "af_heart", name: "Heart · American", gender: "female", useCase: "narration" },
  { id: "am_michael", name: "Michael · American", gender: "male" },
  { id: "bf_emma", name: "Emma · British", gender: "female" },
  { id: "am_fenrir", name: "Fenrir · American", gender: "male" },
  { id: "af_bella", name: "Bella · American", gender: "female" },
  { id: "bm_fable", name: "Fable · British", gender: "male" },
  { id: "af_nicole", name: "Nicole · American (soft)", gender: "female" },
  { id: "am_puck", name: "Puck · American", gender: "male" },
  { id: "bf_isabella", name: "Isabella · British", gender: "female" },
  { id: "bm_lewis", name: "Lewis · British", gender: "male" },
  { id: "af_sarah", name: "Sarah · American", gender: "female" },
  { id: "am_adam", name: "Adam · American", gender: "male" },
  { id: "af_aoede", name: "Aoede · American", gender: "female" },
  { id: "bm_daniel", name: "Daniel · British", gender: "male" },
  { id: "bf_lily", name: "Lily · British", gender: "female" },
  { id: "am_eric", name: "Eric · American", gender: "male" },
  { id: "af_kore", name: "Kore · American", gender: "female" },
  { id: "am_liam", name: "Liam · American", gender: "male" },
  { id: "af_nova", name: "Nova · American", gender: "female" },
  { id: "am_onyx", name: "Onyx · American", gender: "male" },
  { id: "bf_alice", name: "Alice · British", gender: "female" },
  { id: "am_echo", name: "Echo · American", gender: "male" },
  { id: "af_sky", name: "Sky · American", gender: "female" },
  { id: "af_river", name: "River · American", gender: "female" },
  { id: "af_jessica", name: "Jessica · American", gender: "female" },
  { id: "af_alloy", name: "Alloy · American", gender: "female" },
];

/**
 * The voice pack needs a few hundred MB of memory. Phone and tablet browsers kill the
 * tab when it loads (seen on iPhone), so it is only offered on computers.
 */
export function builtinSupported(): boolean {
  if (typeof window === "undefined" || typeof Worker === "undefined" || typeof WebAssembly === "undefined") return false;
  const ua = navigator.userAgent;
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const lowMemory = ((navigator as any).deviceMemory ?? 8) < 4;
  return !mobile && !lowMemory;
}

export class BuiltinVoices {
  /** null = not started, 0–1 = downloading the voice pack, 1 = ready */
  progress: number | null = null;
  ready = false;
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (url: string) => void; reject: (e: Error) => void }>();
  private seq = 0;

  constructor(private onChange: () => void) {}

  private start() {
    if (this.worker) return this.worker;
    const w = new Worker("/voice/kokoro.worker.js", { type: "module" });
    this.progress = 0;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "progress") {
        this.progress = Math.max(this.progress ?? 0, m.progress);
        return this.onChange();
      }
      if (m.type === "ready") {
        this.ready = true;
        this.progress = 1;
        return this.onChange();
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`Built-in voice failed: ${m.error}`));
      else p.resolve(URL.createObjectURL(new Blob([m.buffer], { type: "audio/wav" })));
    };
    w.onerror = () => {
      const err = new Error("Built-in voices couldn't load on this device. Try the device voices instead.");
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
      this.worker = null;
      this.progress = null;
      this.onChange();
    };
    this.worker = w;
    return w;
  }

  /** Start downloading the voice pack in the background. */
  warm() {
    this.start().postMessage({ type: "load" });
  }

  generate(text: string, voice: string, speed: number): Promise<string> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.start().postMessage({ id, text, voice, speed });
    });
  }
}
