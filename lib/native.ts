// The Android app's native voice: the studio voice (Kokoro v1.0) running on the phone's
// own processor through the app (window.VBNative, see android/…/NativeBridge.kt).
// Only present inside the Voicebook Android app.

import { asset } from "./paths";

export type NativeTier = "light" | "fast" | "best";

interface Bridge {
  info(): string;
  download(tier: string): void;
  remove(tier: string): void;
  speak(id: string, tier: string, text: string, sid: number, speed: number): void;
  setPlaying(playing: boolean, title: string, subtitle: string): void;
  setMedia?(playing: boolean, title: string, subtitle: string, progress: number): void;
  openExternal(url: string): void;
  scanFolder?(): void;
  installUpdate?(url: string): void;
  storageInfo?(): string;
  clearCache?(): void;
  freeMemory?(): void;
  allowBackground?(): void;
  openStorageSettings?(): void;
  scanPhone?(): void;
  hasAllFiles?(): boolean;
  rescan?(): void;
  forgetFolders?(): void;
}

export interface NativeStorage {
  voicesBytes: number;
  cacheBytes: number;
  appDataBytes: number;
  freeBytes: number;
  totalBytes: number;
  phoneMemoryFreeMb: number;
  phoneMemoryLow: boolean;
  appMemoryMb: number;
  backgroundAllowed: boolean;
}

/** A book file found in a folder on the phone. */
export interface FoundFile {
  id: string;
  name: string;
  size: number;
  modified: number;
  folder: string;
}

export interface ScanResult {
  auto: boolean;
  folders: string[];
  files: FoundFile[];
}

interface TierStatus {
  ready: boolean;
  mb: number;
  downloading: boolean;
  progress: number;
}

interface Info {
  version: string;
  versionCode: number;
  cores: number;
  threads: number;
  memoryMb: number;
  tiers: Partial<Record<NativeTier, TierStatus>>;
}

/** Speaker numbers in the native model (checked against the voice files). */
export const NATIVE_SIDS: Record<string, number> = {
  af_alloy: 0, af_aoede: 1, af_bella: 2, af_heart: 3, af_jessica: 4, af_kore: 5, af_nicole: 6, af_nova: 7,
  af_river: 8, af_sarah: 9, af_sky: 10, am_adam: 11, am_echo: 12, am_eric: 13, am_fenrir: 14, am_liam: 15,
  am_michael: 16, am_onyx: 17, am_puck: 18, am_santa: 19, bf_alice: 20, bf_emma: 21, bf_isabella: 22,
  bf_lily: 23, bm_daniel: 24, bm_fable: 25, bm_george: 26, bm_lewis: 27,
};

/**
 * The light voice (Piper, LibriTTS-R: 904 readers) has its own speakers. Each studio voice
 * maps to a reader of the same gender, spread by pitch so characters stay distinct
 * (measured: women 196–280 Hz, men 80–132 Hz).
 */
export const LIGHT_SIDS: Record<string, number> = {
  af_alloy: 354, af_aoede: 447, af_bella: 150, af_heart: 69, af_jessica: 141, af_kore: 579, af_nicole: 378, af_nova: 408, af_river: 558, af_sarah: 180, af_sky: 54, am_adam: 855, am_echo: 24, am_eric: 495, am_fenrir: 531, am_liam: 888, am_michael: 858, am_onyx: 339, am_puck: 690, am_santa: 90, bf_alice: 336, bf_emma: 93, bf_isabella: 450, bf_lily: 9, bm_daniel: 219, bm_fable: 243, bm_george: 168, bm_lewis: 369,
};

export const NATIVE_TIERS: Record<NativeTier, { name: string; blurb: string }> = {
  light: { name: "Light", blurb: "A lighter voice, many times faster. For budget phones: reads without pauses." },
  fast: { name: "Fast", blurb: "Compressed studio voice. Quick on most phones, very close in quality." },
  best: { name: "Best", blurb: "The full studio voice, exactly like the server. Needs a recent phone (6 GB+ memory)." },
};

/** Served by the web app itself (the GitHub repository is private). */
export const ANDROID_APK_URL = asset("/download/voicebook.apk");

const bridge = (): Bridge | undefined =>
  typeof window !== "undefined" ? (window as unknown as { VBNative?: Bridge }).VBNative : undefined;

/** Running inside the Voicebook Android app. */
export const inAndroidApp = () => !!bridge();

const TIER_KEY = "vb:native-tier";

export class NativeVoice {
  info: Info | null = null;
  tier: NativeTier = "fast";
  error: string | null = null;
  private pending = new Map<string, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();
  private seq = 0;
  /** A newer app on the website: { versionName, versionCode }. */
  update: { versionName: string; versionCode: number } | null = null;
  /** null = not updating, 0–1 = downloading the update. */
  updateProgress: number | null = null;
  updateError: string | null = null;
  /** Called once when this phone proves too slow for the chosen voice and Light takes over. */
  onSlow: (() => void) | null = null;
  private slowCount = 0;
  /** Called with the books found when a folder scan finishes. */
  onScan: ((r: ScanResult) => void) | null = null;

  constructor(private onChange: () => void) {
    const b = bridge();
    if (!b) return;
    (window as unknown as { __vbNativeEvent?: (t: string, d: Record<string, unknown>) => void }).__vbNativeEvent = (t, d) => this.onEvent(t, d);
    this.refresh();
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(TIER_KEY);
    } catch {}
    this.tier = saved === "best" || saved === "fast" || (saved === "light" && this.hasLight) ? saved : this.recommended;
  }

  get available() {
    return !!bridge();
  }

  /** This app has the Light voice (app 1.17+). */
  get hasLight() {
    return !!this.info?.tiers?.light;
  }

  /** The sizes this app offers, lightest first. */
  get tiers(): NativeTier[] {
    return (["light", "fast", "best"] as NativeTier[]).filter((t) => this.info?.tiers?.[t]);
  }

  /** Budget phones get Light; Kokoro needs a strong processor to keep up with reading. */
  get recommended(): NativeTier {
    const mb = this.info?.memoryMb ?? 0;
    if (!this.hasLight) return mb >= 5500 ? "best" : "fast";
    return mb >= 11000 ? "best" : mb >= 7500 ? "fast" : "light";
  }

  status(t: NativeTier = this.tier): TierStatus | null {
    return this.info?.tiers?.[t] ?? null;
  }

  get ready() {
    return !!this.status()?.ready;
  }

  get downloading() {
    return !!this.status()?.downloading;
  }

  get progress() {
    return this.status()?.progress ?? 0;
  }

  refresh() {
    try {
      this.info = JSON.parse(bridge()!.info());
    } catch {
      this.info = null;
    }
  }

  setTier(t: NativeTier) {
    this.tier = t;
    try {
      localStorage.setItem(TIER_KEY, t);
    } catch {}
    this.onChange();
  }

  download(t: NativeTier = this.tier) {
    const s = this.status(t);
    if (!s || s.ready || s.downloading) return;
    this.error = null;
    s.downloading = true;
    s.progress = 0;
    bridge()?.download(t);
    this.onChange();
  }

  remove(t: NativeTier) {
    bridge()?.remove(t);
  }

  /** Is there a newer app on the website than this one? */
  async checkUpdate() {
    if (!this.info) return;
    try {
      const r = await fetch(asset(`/download/version.json?t=${Date.now()}`), { cache: "no-store" });
      const v = (await r.json()) as { versionName: string; versionCode: number };
      this.update = v.versionCode > (this.info.versionCode ?? 0) ? v : null;
      this.onChange();
    } catch {}
  }

  /** One tap: the app downloads the update and opens Android's install screen. */
  installUpdate() {
    const b = bridge();
    const url = `${location.origin}${ANDROID_APK_URL}`;
    if (b?.installUpdate) {
      this.updateProgress = 0;
      this.updateError = null;
      b.installUpdate(url);
    } else b?.openExternal(url); // older app: the browser downloads it
    this.onChange();
  }

  // ---------- Storage & speed (app 1.16+) ----------
  storageInfo(): NativeStorage | null {
    try {
      const s = bridge()?.storageInfo?.();
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  }
  clearCache() {
    bridge()?.clearCache?.();
  }
  freeMemory() {
    bridge()?.freeMemory?.();
  }
  allowBackground() {
    bridge()?.allowBackground?.();
  }
  openStorageSettings() {
    bridge()?.openStorageSettings?.();
  }

  /** Scanning folders needs the newer app (version with folder access). */
  get canScan() {
    return typeof bridge()?.scanFolder === "function";
  }

  scanFolder() {
    bridge()?.scanFolder?.();
  }

  /** The whole phone (asks once for "all files" access). Falls back to choosing a folder on older apps. */
  scanPhone() {
    const b = bridge();
    if (b?.scanPhone) b.scanPhone();
    else b?.scanFolder?.();
  }

  get canScanPhone() {
    return typeof bridge()?.scanPhone === "function";
  }

  rescan() {
    bridge()?.rescan?.();
  }

  forgetFolders() {
    bridge()?.forgetFolders?.();
  }

  /** The bytes of a book found on the phone, as a File ready to import. */
  async readFound(f: FoundFile): Promise<File> {
    const r = await fetch(`/__native/file/${f.id}`);
    if (!r.ok) throw new Error(`couldn't open ${f.name}`);
    return new File([await r.blob()], f.name, { lastModified: f.modified || Date.now() });
  }

  setPlaying(playing: boolean, title: string, subtitle: string, progress = -1) {
    try {
      const b = bridge();
      if (b?.setMedia) b.setMedia(playing, title, subtitle, progress);
      else b?.setPlaying(playing, title, subtitle);
    } catch {}
  }

  generate(text: string, voice: string, speed: number): Promise<Blob> {
    const b = bridge();
    if (!b) return Promise.reject(new Error("the phone voice is only available in the Android app"));
    if (!this.ready) {
      this.download();
      return new Promise((resolve, reject) => {
        // Wait for the download, then speak.
        const started = Date.now();
        const check = () => {
          if (this.ready) return void this.generate(text, voice, speed).then(resolve, reject);
          if (this.error) return reject(new Error(this.error));
          if (Date.now() - started > 30 * 60_000) return reject(new Error("the phone voice download took too long"));
          setTimeout(check, 1000);
        };
        check();
      });
    }
    const id = `n${Date.now().toString(36)}${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const sid = this.tier === "light" ? LIGHT_SIDS[voice] ?? LIGHT_SIDS.af_heart : NATIVE_SIDS[voice] ?? 3;
      b.speak(id, this.tier, text, sid, speed);
    });
  }

  /**
   * Making a passage slower than it takes to read it means pauses that never catch up.
   * Twice in a row on Fast or Best → switch to Light (downloads once, 82 MB).
   */
  private watchSpeed(took: number, seconds: number, tier: string) {
    if (!(took > 0 && seconds > 0) || tier === "light" || !this.hasLight || this.tier === "light") return;
    this.slowCount = took > seconds * 0.95 ? this.slowCount + 1 : 0;
    if (this.slowCount < 2) return;
    this.slowCount = 0;
    this.setTier("light");
    this.download("light");
    this.onSlow?.();
  }

  private onEvent(type: string, d: Record<string, unknown>) {
    const tier = d.tier as NativeTier | undefined;
    const s = tier ? this.status(tier) : null;
    if (type === "progress" && s) {
      s.downloading = true;
      s.progress = Number(d.progress) || 0;
    } else if (type === "downloaded" || type === "removed") {
      this.refresh();
    } else if (type === "downloadError") {
      this.refresh();
      this.error = `The phone voice couldn't download: ${d.error}`;
    } else if (type === "updateProgress") {
      this.updateProgress = Number(d.progress) || 0;
    } else if (type === "updateError") {
      this.updateProgress = null;
      this.updateError = `The update couldn't download: ${d.error}`;
    } else if (type === "scan") {
      this.onScan?.(d as unknown as ScanResult);
      return;
    } else if (type === "result") {
      const job = this.pending.get(String(d.id));
      if (!job) return;
      this.pending.delete(String(d.id));
      if (d.error) job.reject(new Error(`the phone voice failed: ${d.error}`));
      else {
        this.watchSpeed(Number(d.took), Number(d.seconds), String(d.tier ?? ""));
      }
      if (!d.error)
        fetch(String(d.url))
          .then((r) => {
            if (!r.ok) throw new Error(`the phone voice's audio was missing (${r.status})`);
            return r.blob();
          })
          .then((blob) => job.resolve(blob.type ? blob : new Blob([blob], { type: "audio/wav" })), job.reject);
      return;
    }
    this.onChange();
  }
}
