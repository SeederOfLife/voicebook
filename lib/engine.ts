// The reading engine: analyses the book part by part, casts voices,
// fetches/prefetches speech, plays segments in order, remembers your place,
// and drives the premium soundscape + sound effects.
import { splitLongSegments, splitSentences } from "./chunk";
import { BUILTIN_VOICES, BuiltinVoices, builtinCrashedLastTime, builtinNeedsOptIn, builtinOptedIn, builtinSupported, setBuiltinOptIn } from "./builtin";
import { heuristicAnalyze } from "./heuristic";
import { library, type BookRecord, type VoiceTweak } from "./library";
import { Soundscape } from "./soundscape";
import type { Analysis, AppConfig, Chapter, Character, Provider, Scene, Segment, VoiceOption } from "./types";
import { browserProsody, browserVoiceOptions, castVoices } from "./voices";

const MAX_SEGMENT = 600;
const LOOKAHEAD_SEGMENTS = 10;
const PREFETCH_AUDIO = 2;

export interface Prefs {
  ambience: boolean;
  music: boolean;
  sfx: boolean;
  bgVolume: number;
  /** Device voices: how strongly emotions change pitch, speed and volume (0 = flat, 1 = normal, 2 = dramatic) */
  expressiveness: number;
  /** Device voices: length of the pauses between lines (0 = none, 1 = normal, 2 = long) */
  pauses: number;
  /** Device voices: give characters a different pitch by gender and age */
  characterPitch: boolean;
  /** Device voices: one voice reads everything (the most natural) */
  singleVoice: boolean;
}

const PREFS_KEY = "vb:prefs2";

function silentWavUrl(): string {
  const sr = 8000;
  const n = 400;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export class ReaderEngine {
  bookId = "";
  title = "";
  chunks: string[] = [];
  chapters: Chapter[] = [];
  segments: Segment[] = [];
  characters: Character[] = [];
  meta = { genre: "", language: "", narrationStyle: "" };
  scenes = new Map<number, Scene>();
  analyzedUpTo = -1;
  aiUsed = false;
  aiUnavailable = false;

  index = 0;
  playing = false;
  buffering = false;
  analyzing = false;
  rate = 1;
  provider: Provider = "browser";
  casting: Record<string, string> = {};
  castingByProvider: Partial<Record<Provider, Record<string, string>>> = {};
  accents: Record<string, string> = {};
  error: string | null = null;
  premiumPrompt = false;

  config: AppConfig | null = null;
  password = "";
  accessToken = "";
  browserVoices: VoiceOption[] = [];
  prefs: Prefs = { ambience: true, music: true, sfx: true, bgVolume: 0.6, expressiveness: 0.5, pauses: 1, characterPitch: false, singleVoice: true };
  tweaks: Record<string, VoiceTweak> = {};
  soundscape = new Soundscape();
  builtin: BuiltinVoices;
  notice: string | null = null;

  private audio: HTMLAudioElement;
  private cache = new Map<string, Promise<string>>();
  private sfxCache = new Map<string, Promise<string>>();
  private token = 0;
  private gen = 0;
  private analyzePromise: Promise<void> | null = null;
  private pendingOffset: number | null = null;
  private loadedKey = "";
  private unlocked = false;
  private silent = "";

  constructor(private onChange: () => void) {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.builtin = new BuiltinVoices(onChange);
    if (builtinCrashedLastTime()) {
      if (store.get("vb:provider") === "builtin") store.set("vb:provider", "browser");
      this.notice = "The built-in AI voices needed more memory than this browser allows and it closed the page, so they've been switched off. Your device's voices are reading instead.";
    }
    this.password = store.get("vb:password") ?? "";
    this.rate = Number(store.get("vb:rate")) || 1;
    try {
      this.prefs = { ...this.prefs, ...JSON.parse(store.get(PREFS_KEY) ?? "{}") };
    } catch {}
    this.soundscape.volume = this.prefs.bgVolume;
    if ("speechSynthesis" in window) {
      const load = () => {
        this.browserVoices = browserVoiceOptions();
        if (this.provider === "browser") this.recast();
        this.onChange();
      };
      load();
      window.speechSynthesis.addEventListener?.("voiceschanged", load);
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => this.play());
      navigator.mediaSession.setActionHandler("pause", () => this.pause());
      navigator.mediaSession.setActionHandler("nexttrack", () => this.jump(this.index + 1));
      navigator.mediaSession.setActionHandler("previoustrack", () => this.jump(Math.max(0, this.index - 1)));
    }
    window.addEventListener("pagehide", () => this.savePosition());
  }

  // ---------- account / config ----------

  get premium() {
    return this.config?.plan === "premium";
  }

  setConfig(c: AppConfig) {
    this.config = c;
    const saved = store.get("vb:provider") as Provider | null;
    const available = this.availableProviders();
    const prev = this.provider;
    this.provider = saved && available.includes(saved) ? saved : available[0];
    if (!this.premium) this.soundscape.stop();
    if (prev !== this.provider) this.casting = this.castingByProvider[this.provider] ?? {};
    this.recast();
    this.onChange();
  }

  /** Engines this account can use right now. */
  availableProviders(): Provider[] {
    const p: Provider[] = [];
    if (this.premium && this.config?.providers.elevenlabs) p.push("elevenlabs");
    if (this.premium && this.config?.providers.openai) p.push("openai");
    if (builtinSupported()) p.push("builtin");
    p.push("browser");
    return p;
  }

  /** Engines that exist on this server but need Premium. */
  lockedProviders(): Provider[] {
    if (this.premium || !this.config) return [];
    const p: Provider[] = [];
    if (this.config.providers.elevenlabs) p.push("elevenlabs");
    if (this.config.providers.openai) p.push("openai");
    return p;
  }

  /** On phones the built-in AI voices are an opt-in switch (they can run out of memory). */
  get builtinIsOptional() {
    return builtinNeedsOptIn();
  }
  get builtinOn() {
    return builtinOptedIn();
  }
  setBuiltin(on: boolean) {
    setBuiltinOptIn(on);
    if (on) this.setProvider("builtin");
    else {
      this.builtin.stop();
      if (this.provider === "builtin") this.setProvider("browser");
    }
    this.onChange();
  }

  setPassword(pw: string) {
    this.password = pw;
    store.set("vb:password", pw);
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.password) h["x-app-password"] = this.password;
    if (this.accessToken) h.authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  setPrefs(p: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...p };
    store.set(PREFS_KEY, JSON.stringify(this.prefs));
    this.soundscape.setVolume(this.prefs.bgVolume);
    this.applyScene();
    this.onChange();
  }

  // ---------- books ----------

  async open(book: BookRecord) {
    this.pause();
    this.clearAudioCache();
    this.bookId = book.id;
    this.title = book.title;
    this.chunks = book.chunks;
    this.chapters = book.chapters;
    this.characters = book.characters ?? [];
    this.meta = book.meta ?? { genre: "", language: "", narrationStyle: "" };
    this.castingByProvider = book.casting ?? {};
    this.accents = book.accents ?? {};
    this.tweaks = book.tweaks ?? {};
    this.casting = this.castingByProvider[this.provider] ?? {};
    this.scenes.clear();
    this.aiUsed = false;
    this.error = null;
    const preferred = store.get("vb:provider") as Provider | null;
    if (preferred && preferred !== this.provider && this.availableProviders().includes(preferred)) this.provider = preferred;
    this.casting = this.castingByProvider[this.provider] ?? {};
    this.recast();
    const pos = book.position ?? { chunk: 0, offset: 0 };
    this.startAt(Math.min(pos.chunk, this.chunks.length - 1), pos.offset);
    library.patch(book.id, { openedAt: Date.now() });
  }

  close() {
    this.savePosition();
    this.pause();
    this.soundscape.stop();
    this.bookId = "";
    this.chunks = [];
    this.chapters = [];
    this.segments = [];
    this.gen++;
    this.onChange();
  }

  private startAt(chunk: number, offset: number) {
    this.gen++;
    this.token++;
    this.segments = [];
    this.groupEnd = 0;
    this.index = 0;
    this.analyzedUpTo = Math.max(0, chunk) - 1;
    this.analyzePromise = null;
    this.analyzing = false;
    this.pendingOffset = offset;
    this.loadedKey = "";
    this.analyzeNext();
    this.onChange();
  }

  /** Jump to a chapter/part. Analyses it on demand if it's far ahead or behind. */
  jumpToChunk(c: number) {
    const i = this.segments.findIndex((s) => s.chunk === c);
    if (i >= 0) return this.jump(i);
    const wasPlaying = this.playing;
    this.audio.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.startAt(c, 0);
    this.playing = wasPlaying;
    if (wasPlaying) this.playCurrent();
  }

  /** 0–1 through the whole book. */
  progress(): number {
    const seg = this.segments[this.index];
    if (!seg || !this.chunks.length) return 0;
    const inChunk = this.segments.filter((s) => s.chunk === seg.chunk);
    return (seg.chunk + inChunk.indexOf(seg) / Math.max(1, inChunk.length)) / this.chunks.length;
  }

  currentChapterIndex(): number {
    const c = this.segments[this.index]?.chunk ?? this.analyzedUpTo + 1;
    let idx = 0;
    this.chapters.forEach((ch, i) => {
      if (ch.chunk <= c) idx = i;
    });
    return idx;
  }

  savePosition() {
    const seg = this.segments[this.index];
    if (!this.bookId || !seg) return;
    const first = this.segments.findIndex((s) => s.chunk === seg.chunk);
    library.patch(this.bookId, { position: { chunk: seg.chunk, offset: this.index - first }, openedAt: Date.now() });
  }

  private saveBookState() {
    if (!this.bookId) return;
    library.patch(this.bookId, {
      characters: this.characters,
      meta: this.meta,
      casting: this.castingByProvider,
      accents: this.accents,
      tweaks: this.tweaks,
    });
  }

  // ---------- analysis ----------

  voicesFor(p: Provider = this.provider): VoiceOption[] {
    if (p === "openai") return this.config?.voices.openai ?? [];
    if (p === "elevenlabs") return this.config?.voices.elevenlabs ?? [];
    if (p === "builtin") return BUILTIN_VOICES;
    const lang = this.meta.language;
    // Device voices: only the best-quality reading voices. English first; another
    // language only when the book itself is in that language.
    const good = this.browserVoices.filter((v) => !v.fun);
    const inLang = (l: string) => good.filter((v) => v.lang?.toLowerCase().startsWith(l));
    const pool = (lang && !lang.startsWith("en") && inLang(lang).length ? inLang(lang) : inLang("en")) || good;
    const list = pool.length ? pool : good;
    const top = list.filter((v) => v.name.startsWith("★"));
    return top.length ? top : list.slice(0, 4);
  }

  /** True when one device voice reads the whole book. */
  get oneVoice() {
    return this.provider === "browser" && this.prefs.singleVoice;
  }

  /** Voices for the picker, grouped. Device voices include every language, accent and the fun ones. */
  voiceGroups(): { label: string; voices: VoiceOption[] }[] {
    return [{ label: "", voices: this.voicesFor() }];
  }

  setTweak(speaker: string, t: Partial<VoiceTweak>) {
    const cur = this.tweaks[speaker] ?? { pitch: 1, speed: 1 };
    this.tweaks = { ...this.tweaks, [speaker]: { ...cur, ...t } };
    this.saveBookState();
    this.onChange();
  }

  private recast() {
    this.casting = castVoices(this.characters, this.voicesFor(), this.meta.genre || "other", this.casting);
    this.castingByProvider = { ...this.castingByProvider, [this.provider]: this.casting };
    for (const ch of this.characters) if (!(ch.name in this.accents)) this.accents[ch.name] = ch.accent ?? "";
  }

  analyzeNext(): Promise<void> {
    if (this.analyzePromise) return this.analyzePromise;
    const c = this.analyzedUpTo + 1;
    if (c >= this.chunks.length) return Promise.resolve();
    const gen = this.gen;
    this.analyzing = true;
    this.onChange();
    this.analyzePromise = (async () => {
      const text = this.chunks[c];
      const bookId = this.bookId;
      let a: Analysis | null = (bookId && (await library.getAnalysis(bookId, c))) || null;
      if (a) this.aiUsed = true;
      if (!a && !this.aiUnavailable) {
        try {
          const r = await fetch("/api/analyze", {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({
              text,
              knownCharacters: this.characters.map(({ name, gender, age, traits }) => ({ name, gender, age, traits })),
              context: this.meta.genre ? this.meta : null,
            }),
          });
          if (r.status === 501) this.aiUnavailable = true;
          else if (r.ok) {
            a = await r.json();
            this.aiUsed = true;
            if (a && bookId) library.putAnalysis(bookId, c, a);
          }
        } catch {
          /* network error: fall back for this part */
        }
      }
      if (gen === this.gen) this.apply(a ?? heuristicAnalyze(text, this.characters), c);
    })().finally(() => {
      if (gen !== this.gen) return;
      this.analyzePromise = null;
      this.analyzing = false;
      this.onChange();
    });
    return this.analyzePromise;
  }

  private apply(a: Analysis, c: number) {
    if (!this.meta.genre || (this.meta.genre === "other" && a.genre !== "other")) this.meta.genre = a.genre;
    if (!this.meta.language && a.language) this.meta.language = a.language;
    if (!this.meta.narrationStyle && a.narrationStyle) this.meta.narrationStyle = a.narrationStyle;
    if (this.provider === "builtin") {
      if (this.meta.language && !this.meta.language.toLowerCase().startsWith("en")) {
        // The built-in voice pack only speaks English.
        this.setProvider("browser", false);
        this.notice = `The built-in AI voices only speak English, so this ${this.meta.language.toUpperCase()} book uses your device's voices.`;
      } else this.builtin.warm();
    }
    if (a.scene) this.scenes.set(c, a.scene);

    const byName = new Map(this.characters.map((ch) => [ch.name.toLowerCase(), ch]));
    for (const ch of a.characters) {
      const known = byName.get(ch.name.toLowerCase());
      if (!known) byName.set(ch.name.toLowerCase(), ch);
      else if (!known.accent && ch.accent) known.accent = ch.accent;
    }
    for (const s of a.segments) {
      if (s.speaker !== "Narrator" && !byName.has(s.speaker.toLowerCase()))
        byName.set(s.speaker.toLowerCase(), { name: s.speaker, gender: "neutral", age: "adult" });
    }
    const segs = a.segments.map((s) => ({
      ...s,
      speaker: s.speaker === "Narrator" ? s.speaker : byName.get(s.speaker.toLowerCase())?.name ?? s.speaker,
    }));
    this.characters = [...byName.values()];
    const start = this.segments.length;
    splitLongSegments(segs, MAX_SEGMENT).forEach((s, i) =>
      this.segments.push({ ...s, id: `${c}-${start + i}`, chunk: c }),
    );
    // Avoid repeating one sound effect on every piece of a split segment.
    for (let i = start + 1; i < this.segments.length; i++)
      if (this.segments[i].sfx && this.segments[i].sfx === this.segments[i - 1].sfx) this.segments[i].sfx = "";
    this.analyzedUpTo = c;
    if (this.pendingOffset !== null) {
      this.index = Math.min(this.pendingOffset, Math.max(0, this.segments.length - 1));
      this.pendingOffset = null;
      this.savePosition();
    }
    this.recast();
    this.saveBookState();
  }

  character(name: string) {
    return this.characters.find((c) => c.name === name);
  }

  // ---------- playback ----------

  private unlock() {
    this.soundscape.unlock();
    if (this.unlocked) return;
    this.unlocked = true;
    if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    this.silent ||= silentWavUrl();
    this.audio.src = this.silent;
    this.audio.play().catch(() => {});
  }

  play() {
    this.previewAudio?.pause();
    if (this.premium) this.soundscape.unlock();
    const seg = this.segments[this.index];
    if (this.provider !== "browser" && seg && this.loadedKey === this.keyFor(seg) && this.audio.currentTime > 0 && !this.audio.ended) {
      const t = ++this.token;
      this.playing = true;
      this.audio.onended = () => t === this.token && this.advance();
      this.audio.play().catch((e) => this.fail(e));
      this.soundscape.resume();
      this.onChange();
      return;
    }
    this.unlock();
    this.playing = true;
    this.playCurrent();
  }

  pause() {
    const wasPlaying = this.playing;
    this.playing = false;
    this.buffering = false;
    this.token++;
    this.audio.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.soundscape.pause();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    if (wasPlaying) this.savePosition();
    this.onChange();
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  jump(i: number) {
    this.groupEnd = 0;
    this.index = Math.max(0, Math.min(i, Math.max(0, this.segments.length - 1)));
    this.loadedKey = "";
    if (this.playing) this.playCurrent();
    else {
      this.savePosition();
      this.onChange();
    }
  }

  setRate(r: number) {
    this.rate = r;
    this.audio.playbackRate = r;
    store.set("vb:rate", String(r));
    if (this.playing && this.provider === "browser") this.playCurrent();
    this.onChange();
  }

  setProvider(p: Provider, remember = true) {
    if (remember) this.notice = null;
    if (!this.availableProviders().includes(p)) {
      this.premiumPrompt = true;
      this.onChange();
      return;
    }
    this.pause();
    this.provider = p;
    this.loadedKey = "";
    if (remember) store.set("vb:provider", p);
    if (p === "builtin" && remember) this.builtin.warm();
    this.casting = this.castingByProvider[p] ?? {};
    this.recast();
    this.saveBookState();
    this.onChange();
  }

  setVoice(speaker: string, voiceId: string) {
    this.casting = { ...this.casting, [speaker]: voiceId };
    this.castingByProvider = { ...this.castingByProvider, [this.provider]: this.casting };
    this.saveBookState();
    if (this.playing) this.playCurrent();
    else this.onChange();
  }

  setAccent(speaker: string, accent: string) {
    if (!this.premium) {
      this.premiumPrompt = true;
      this.onChange();
      return;
    }
    this.accents = { ...this.accents, [speaker]: accent };
    this.saveBookState();
    if (this.playing) this.playCurrent();
    else this.onChange();
  }

  private keyFor(seg: Segment) {
    const voice = this.casting[seg.speaker] ?? this.casting.Narrator ?? "";
    return `${this.provider}|${voice}|${this.accents[seg.speaker] ?? ""}|${seg.id}`;
  }

  private audioFor(seg: Segment): Promise<string> {
    const key = this.keyFor(seg);
    let p = this.cache.get(key);
    if (!p && this.provider === "builtin") {
      const pr = browserProsody(seg.emotion, undefined, seg.intensity ?? 1);
      p = this.builtin.generate(seg.text, this.casting[seg.speaker] ?? this.casting.Narrator ?? "af_heart", pr.rate);
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    if (!p) {
      p = fetch("/api/tts", {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          provider: this.provider,
          voice: this.casting[seg.speaker] ?? this.casting.Narrator,
          text: seg.text,
          emotion: seg.emotion,
          delivery: seg.delivery,
          tags: seg.tags,
          intensity: seg.intensity,
          prevText: this.neighbour(seg, -1),
          nextText: this.neighbour(seg, 1),
          speaker: seg.speaker,
          character: this.character(seg.speaker),
          genre: this.meta.genre,
          narrationStyle: this.meta.narrationStyle,
          language: this.meta.language,
          accent: this.accents[seg.speaker] || undefined,
        }),
      }).then(async (r) => {
        if (r.status === 402) this.premiumPrompt = true;
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `Voice error ${r.status}`);
        return URL.createObjectURL(await r.blob());
      });
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
    }
    return p;
  }

  private get sfxOn() {
    return this.premium && this.prefs.sfx && !!this.config?.providers.elevenlabs;
  }

  private sfxFor(desc: string): Promise<string> {
    let p = this.sfxCache.get(desc);
    if (!p) {
      p = fetch("/api/sfx", { method: "POST", headers: this.headers(), body: JSON.stringify({ text: desc }) }).then(async (r) => {
        if (!r.ok) throw new Error("sfx");
        return URL.createObjectURL(await r.blob());
      });
      p.catch(() => this.sfxCache.delete(desc));
      this.sfxCache.set(desc, p);
    }
    return p;
  }

  private playSfx(seg: Segment, t: number) {
    if (!this.sfxOn || !seg.sfx) return;
    this.sfxFor(seg.sfx)
      .then((url) => {
        if (t !== this.token) return;
        const a = new Audio(url);
        a.volume = Math.min(1, 0.35 + this.prefs.bgVolume * 0.6);
        a.play().catch(() => {});
      })
      .catch(() => {});
  }

  private applyScene() {
    const seg = this.segments[this.index];
    if (!this.premium || !seg) return this.soundscape.stop();
    let scene: Scene | undefined;
    for (let c = seg.chunk; c >= 0 && !scene; c--) scene = this.scenes.get(c);
    scene ??= { ambience: "none", music: "none" };
    this.soundscape.setScene({
      ambience: this.prefs.ambience ? scene.ambience : "none",
      music: this.prefs.music ? scene.music : "none",
    });
  }

  private fail(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e);
    this.playing = false;
    this.buffering = false;
    this.soundscape.pause();
    this.onChange();
  }

  private async playCurrent() {
    const t = ++this.token;
    this.error = null;
    this.audio.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    while (this.index >= this.segments.length) {
      if (this.analyzedUpTo + 1 >= this.chunks.length) {
        this.playing = false;
        this.buffering = false;
        this.index = Math.max(0, this.segments.length - 1);
        this.soundscape.stop();
        this.onChange();
        return;
      }
      this.buffering = true;
      this.onChange();
      await this.analyzeNext();
      if (t !== this.token) return;
    }
    if (this.segments.length - this.index < LOOKAHEAD_SEGMENTS) this.analyzeNext();

    const seg = this.segments[this.index];
    this.savePosition();
    this.soundscape.resume();
    this.applyScene();
    if ("mediaSession" in navigator) {
      const ch = this.chapters[this.currentChapterIndex()];
      navigator.mediaSession.metadata = new MediaMetadata({ title: ch?.title || this.title, artist: seg.speaker, album: this.title });
      navigator.mediaSession.playbackState = "playing";
    }
    for (let k = 1; k <= 3; k++) {
      const s = this.segments[this.index + k];
      if (s?.sfx && this.sfxOn) this.sfxFor(s.sfx).catch(() => {});
    }

    if (this.provider === "browser") {
      this.buffering = false;
      this.groupEnd = this.oneVoice ? this.flowEnd(this.index) : this.index;
      this.onChange();
      this.playSfx(seg, t);
      if (this.groupEnd > this.index) {
        // One voice: read narration and dialogue together in one breath, like a person would.
        const group = this.segments.slice(this.index, this.groupEnd + 1);
        this.speakBrowser({ ...seg, text: group.map((s) => s.text).join(" "), emotion: "neutral", intensity: 1 }, t);
      } else this.speakBrowser(seg, t);
      return;
    }
    this.groupEnd = this.index;

    this.buffering = true;
    this.onChange();
    try {
      const url = await this.audioFor(seg);
      if (t !== this.token) return;
      for (let k = 1; k <= PREFETCH_AUDIO; k++) {
        const next = this.segments[this.index + k];
        if (next) this.audioFor(next).catch(() => {});
      }
      this.audio.src = url;
      this.audio.volume = this.provider === "builtin" ? browserProsody(seg.emotion, undefined, seg.intensity ?? 1).volume : 1;
      this.audio.defaultPlaybackRate = this.rate;
      this.audio.playbackRate = this.rate;
      this.loadedKey = this.keyFor(seg);
      this.audio.onended = () => t === this.token && this.advance();
      this.playSfx(seg, t);
      await this.audio.play();
      if (t !== this.token) return;
      this.buffering = false;
      this.onChange();
      this.evictOld();
    } catch (e) {
      if (t !== this.token) return;
      if (this.provider === "builtin" && this.browserVoices.length) {
        // Keep reading with the device's voices rather than stopping.
        this.setProvider("browser", false);
        this.notice = "The built-in AI voices couldn't load here (weak connection or not enough memory), so your device's voices are reading instead.";
        this.playing = true;
        this.playCurrent();
      } else this.fail(e);
    }
  }

  private speakBrowser(seg: Segment, t: number, onEnd: () => void = () => this.advance()) {
    const synth = window.speechSynthesis;
    const who = this.oneVoice ? "Narrator" : seg.speaker;
    const voiceId = this.casting[who] ?? this.casting.Narrator;
    const all = synth.getVoices();
    const v = all.find((x) => x.voiceURI === voiceId);
    const p = browserProsody(
      seg.emotion,
      who === "Narrator" || !this.prefs.characterPitch ? undefined : this.character(seg.speaker),
      seg.intensity ?? 1,
      this.prefs.expressiveness,
    );
    const tweak = this.tweaks[who];
    if (tweak) {
      p.pitch = Math.min(2, Math.max(0.1, p.pitch * tweak.pitch));
      p.rate = Math.min(2.5, Math.max(0.4, p.rate * tweak.speed));
    }
    // Speak sentence by sentence: some browsers silently cut off long utterances (~15 s).
    // Voices stored on the device read a whole passage in one breath, which sounds most natural.
    // Only online voices need sentence-sized pieces (some browsers cut them off after ~15 s).
    const pieces = v && v.localService === false ? splitSentences(seg.text, 180) : [seg.text];
    const speakPiece = (i: number) => {
      if (t !== this.token) return;
      if (i >= pieces.length) return onEnd();
      const u = new SpeechSynthesisUtterance(pieces[i]);
      if (v) u.voice = v;
      u.lang = v?.lang || this.meta.language || "en";
      u.rate = Math.min(4, p.rate * this.rate);
      u.pitch = p.pitch;
      u.volume = p.volume;
      u.onend = () => speakPiece(i + 1);
      u.onerror = (e) => {
        if (t !== this.token || e.error === "interrupted" || e.error === "canceled") return;
        this.fail(new Error(`This device's voice failed (${e.error}). Try another voice in 🎭 Voices.`));
      };
      this.utterance = u; // keep a reference: some browsers drop the "end" event otherwise
      synth.speak(u);
    };
    speakPiece(0);
  }

  private utterance: SpeechSynthesisUtterance | null = null;

  /** A short, natural silence between lines — longer after headings, scene changes and speaker changes. */
  private gapAfter(seg: Segment, next?: Segment): number {
    if (!next) return 0;
    let ms = 140;
    if (next.speaker !== seg.speaker) ms = 320;
    if (/heading/i.test(seg.delivery ?? "") || (seg.text.length < 80 && !/[.!?…"”»]$/.test(seg.text))) ms = 750;
    if (/(…|\.\.\.)$/.test(seg.text)) ms = Math.max(ms, 520);
    if (next.chunk !== seg.chunk) ms = Math.max(ms, 600);
    if ((next.tags ?? []).some((t) => /pause/i.test(t))) ms += 400;
    return (ms * (this.provider === "browser" ? this.prefs.pauses : 1)) / Math.max(0.75, this.rate);
  }

  private neighbour(seg: Segment, dir: -1 | 1): string | undefined {
    const i = this.segments.indexOf(seg);
    return i < 0 ? undefined : this.segments[i + dir]?.text;
  }

  /** Last line read together with the current one (one-voice mode). */
  groupEnd = 0;

  private isHeading(s: Segment) {
    return /heading/i.test(s.delivery ?? "") || (s.text.length < 80 && !/[.!?…"”»,;:]$/.test(s.text.trim()));
  }

  private flowEnd(i: number): number {
    const first = this.segments[i];
    if (this.isHeading(first)) return i;
    let len = first.text.length;
    let j = i;
    for (let n = this.segments[j + 1]; n && n.chunk === first.chunk && !this.isHeading(n) && len + n.text.length <= 450; n = this.segments[j + 1]) {
      len += n.text.length + 1;
      j++;
    }
    return j;
  }

  private advance() {
    const seg = this.segments[Math.max(this.index, this.groupEnd)];
    this.index = Math.max(this.index, this.groupEnd);
    this.index++;
    this.loadedKey = "";
    if (!this.playing) return this.onChange();
    const gap = seg ? this.gapAfter(seg, this.segments[this.index]) : 0;
    const t = this.token;
    this.onChange();
    if (gap) setTimeout(() => this.playing && t === this.token && this.playCurrent(), gap);
    else this.playCurrent();
  }

  // ---------- voice preview ----------

  private previewAudio: HTMLAudioElement | null = null;
  previewing = "";

  /** Plays a short sample of the voice currently cast for `speaker`. */
  async preview(speaker: string) {
    this.pause();
    this.unlock();
    this.previewAudio?.pause();
    const line =
      this.segments.find((s) => s.speaker === speaker && s.text.length > 25 && s.text.length < 220) ??
      this.segments.find((s) => s.speaker === speaker);
    const sample: Segment = line ?? {
      id: `preview-${speaker}`,
      chunk: -1,
      speaker,
      emotion: "neutral",
      text: speaker === "Narrator" ? "Once upon a time, in a quiet town by the sea, a story was waiting to be told." : `Hello. My name is ${speaker}.`,
    };
    this.previewing = speaker;
    this.onChange();
    try {
      if (this.provider === "browser") {
        const t = ++this.token;
        await new Promise<void>((resolve) => {
          this.speakBrowser(sample, t, resolve);
          setTimeout(resolve, 15000); // safety net if the device never fires "end"
        });
      } else {
        const url = await this.audioFor({ ...sample, id: `preview-${sample.id}` });
        this.previewAudio = new Audio(url);
        this.previewAudio.playbackRate = this.rate;
        await this.previewAudio.play();
        await new Promise((r) => this.previewAudio!.addEventListener("ended", r, { once: true }));
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.previewing = "";
      this.onChange();
    }
  }

  private evictOld() {
    const keep = new Set(this.segments.slice(Math.max(0, this.index - 3), this.index + 5).map((s) => s.id));
    for (const [key, p] of this.cache) {
      const id = key.split("|").pop()!;
      if (!keep.has(id)) {
        this.cache.delete(key);
        p.then((u) => setTimeout(() => URL.revokeObjectURL(u), 1000)).catch(() => {});
      }
    }
  }

  private clearAudioCache() {
    this.cache.forEach((p) => p.then(URL.revokeObjectURL).catch(() => {}));
    this.cache.clear();
  }

  destroy() {
    this.pause();
    this.soundscape.stop();
    this.clearAudioCache();
  }
}
