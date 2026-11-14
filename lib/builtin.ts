// The studio voice generated inside the browser (a Web Worker running the Kokoro
// model). Used on computers when the server's studio voice isn't available.
// Phones and tablets don't have the memory for it, so it is never used there.
import type { VoiceOption } from "./types";
import { STUDIO_VOICES } from "./voices";

/** Same voices as the server's studio voice, so switching between the two is seamless. */
export const BUILTIN_VOICES: VoiceOption[] = STUDIO_VOICES;

export function builtinSupported(): boolean {
  if (typeof window === "undefined" || typeof Worker === "undefined" || typeof WebAssembly === "undefined") return false;
  const ua = navigator.userAgent;
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const lowMemory = ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) < 4;
  return !mobile && !lowMemory;
}

export class BuiltinVoices {
  /** null = not started, 0–1 = downloading the voice pack, 1 = ready */
  progress: number | null = null;
  ready = false;
  private worker: Worker | null = null;
  private pending = new Map<number, { resolve: (audio: Blob) => void; reject: (e: Error) => void }>();
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
      if (m.error) p.reject(new Error(`could not generate the voice on this computer: ${m.error}`));
      else p.resolve(new Blob([m.buffer], { type: "audio/wav" }));
    };
    w.onerror = () => {
      const err = new Error("the voice could not load on this computer");
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

  generate(text: string, voice: string, speed: number): Promise<Blob> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.start().postMessage({ id, text, voice, speed });
    });
  }
}
