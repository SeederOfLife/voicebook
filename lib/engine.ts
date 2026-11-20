// The reading engine: analyses the book part by part, groups lines into passages,
// gets each passage spoken (studio voice, acting voices or the device's own voice),
// keeps the generated audio on the device, remembers your place, and drives the
// background sound.
import { splitSentences } from "./chunk";
import { BuiltinVoices, builtinSupported, type DeviceKind, type Tier } from "./builtin";
import { heuristicAnalyze } from "./heuristic";
import { scanCharacters } from "./cast-scan";
import { NativeVoice } from "./native";
import { api } from "./paths";
import { library, type BookRecord, type VoiceTweak } from "./library";
import { Soundscape } from "./soundscape";
import { FX_SPEAKER, fxUrl, splitEffects, SYSTEM_SPEAKER, type FxKind } from "./fx";
import type { Analysis, AppConfig, Chapter, Character, Emotion, Mood, Provider, RawSegment, Scene, Segment, VoiceOption } from "./types";
import { browserProsody, browserVoiceOptions, castVoices, STUDIO_VOICES } from "./voices";

/** Longest single line, in characters (longer ones are cut at sentence ends). */
const MAX_SEGMENT = 240;
/**
 * The first passages of each part of the book are shorter, so listening can begin
 * sooner while the following, full-length passages are being prepared.
 */
const RAMP = [170, 280];
/** Analyse the next part of the book when fewer than this many lines are left. */
const LOOKAHEAD_SEGMENTS = 14;
/** How many passages to get ready beyond the one being read. */
/** How many passages are kept ready ahead of the one being read (a rolling buffer). */
const AHEAD: Record<Provider, number> = { native: 3, studio: 4, builtin: 3, elevenlabs: 3, openai: 3, browser: 0 };
/**
 * Longest passage read in one go, in characters. Engines that read neutrally get whole
 * passages (more natural flow); acting engines get one line at a time (0), because each
 * line carries its own emotion.
 */
const PASSAGE_CHARS: Record<Provider, number> = { native: 380, studio: 380, builtin: 300, browser: 450, elevenlabs: 0, openai: 0 };

/** After a failure, wait this long before asking the server for the studio voice again. */
const RETRY_MS = 120_000;

const ENGINE_KEY = "vb:engine";
const PREFS_KEY = "vb:prefs3";
const USAGE_KEY = "vb:studio-usage";

export interface Prefs {
  ambience: boolean;
  /** Background music: never, at key moments only, or all the time */
  music: "off" | "moments" | "always";
  sfx: boolean;
  bgVolume: number;
  /** One voice reads everything (the most natural); off = each character gets a voice */
  singleVoice: boolean;
  /** Device voice: how strongly emotions change pitch, speed and volume (0 = flat … 2 = dramatic) */
  expressiveness: number;
  /** Device voice: length of the pauses between passages (0 = none, 1 = normal, 2 = long) */
  pauses: number;
  /** Device voice: give characters a different pitch by gender and age */
  characterPitch: boolean;
}

const DEFAULT_PREFS: Prefs = {
  ambience: true,
  music: "moments",
  sfx: true,
  bgVolume: 0.45,
  singleVoice: false,
  expressiveness: 0.5,
  pauses: 1,
  characterPitch: false,
};

/** What a device has asked of the server's studio voice this month. */
interface Usage {
  month: string;
  /** server computing time, seconds */
  cpu: number;
  /** audio generated, seconds */
  audio: number;
}

/** A stretch of the book spoken in one go by one voice. */
export interface Passage {
  /** first and last line (indexes into `segments`) */
  start: number;
  end: number;
  /** whose voice reads it ("Narrator" when one voice reads everything) */
  speaker: string;
  voice: string;
  text: string;
  /** silence after it, in milliseconds */
  tailMs: number;
  /** identifies the audio of this passage (voice + words), for saving and reuse */
  key: string;
  /** the first line (emotion, acting directions) */
  seg: Segment;
}

class VoiceError extends Error {
  constructor(
    public kind: "limit" | "offline" | "server" | "stale",
    message: string,
  ) {
    super(message);
  }
}

const MOOD_FOR: Partial<Record<Emotion, Mood>> = {
  angry: "tense",
  fearful: "tense",
  sad: "sad",
  tender: "warm",
  happy: "happy",
  excited: "epic",
  surprised: "tense",
  mysterious: "mysterious",
  whisper: "mysterious",
  serious: "tense",
};

const monthKey = () => new Date().toISOString().slice(0, 7);

/** 53-bit string hash (cyrb53), as text. */
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Lines that are not narration: sound effects and game system messages. */
const special = (s: Segment) => !!s.fx || s.speaker === SYSTEM_SPEAKER;

/** A few seconds of silence, looped while waiting so a phone keeps the audio session alive. */
function silentWavUrl(seconds: number): string {
  const sr = 8000;
  const n = Math.round(sr * seconds);
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

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** Work out which lines start a new paragraph by finding them in the book's text. */
function markParagraphs(segs: RawSegment[], source: string) {
  const text = source
    .replace(/\r/g, "")
    .replace(/\n[ \t]*\n\s*/g, "\u0001")
    .replace(/\s+/g, " ")
    .replace(/ ?\u0001 ?/g, "\n");
  let cursor = 0;
  let reach = 80;
  for (const s of segs) {
    const flat = s.text.replace(/\s+/g, " ").trim();
    const probe = flat.slice(0, 28);
    if (!probe) continue;
    const at = text.indexOf(probe, cursor);
    if (at < 0 || at - cursor > reach) {
      reach += flat.length + 4; // not where expected (the text was repaired): leave it unmarked
      continue;
    }
    s.para = at === 0 || /\n["“«„'‘(\[]*$/.test(text.slice(Math.max(0, at - 4), at));
    cursor = at + probe.length;
    reach = flat.length + 80;
  }
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
  remove(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

export class ReaderEngine {
  bookId = "";
  title = "";
  author = "";
  folder = "";
  /** The AI is casting the characters of this book right now. */
  casting_ai = false;
  /** Voices chosen by hand in this book. */
  private manualVoices = new Set<string>();
  chunks: string[] = [];
  chapters: Chapter[] = [];
  segments: Segment[] = [];
  characters: Character[] = [];
  meta = { genre: "", language: "", narrationStyle: "" };
  scenes = new Map<number, Scene>();
  analyzedUpTo = -1;
  aiUsed = false;
  aiUnavailable = false;

  /** First line of the passage being read (or about to be). */
  index = 0;
  /** Last line of that passage. */
  groupEnd = 0;
  playing = false;
  buffering = false;
  analyzing = false;
  /** When the current wait for audio began (ms), for the "preparing…" display. */
  waitingSince = 0;
  rate = 1;
  provider: Provider = "browser";
  casting: Record<string, string> = {};
  castingByProvider: Partial<Record<Provider, Record<string, string>>> = {};
  accents: Record<string, string> = {};
  tweaks: Record<string, VoiceTweak> = {};
  error: string | null = null;
  notice: string | null = null;
  premiumPrompt = false;

  config: AppConfig | null = null;
  password = "";
  accessToken = "";
  browserVoices: VoiceOption[] = [];
  prefs: Prefs = { ...DEFAULT_PREFS };
  soundscape = new Soundscape();
  builtin: BuiltinVoices;
  /** The Android app's native phone voice (absent elsewhere). */
  native: NativeVoice;
  /** The server's studio voice has produced audio during this visit. */
  studioReady = false;
  /** Passages of the open book whose audio is saved on this device. */
  savedPassages = 0;
  previewing = "";

  private usage: Usage = { month: monthKey(), cpu: 0, audio: 0 };
  private audio: HTMLAudioElement;
  private cache = new Map<string, Promise<string>>();
  private sfxCache = new Map<string, Promise<string>>();
  private token = 0;
  private gen = 0;
  /** Changes whenever the listener moves elsewhere; queued look-ahead work from before is dropped. */
  private epoch = 0;
  private analyzePromise: Promise<void> | null = null;
  private pendingOffset: number | null = null;
  private justOpened = false;
  private loadedKey = "";
  private unlocked = false;
  private silent = "";
  private storageFull = false;
  private lastMusic: { chunk: number; mood: Mood } | null = null;
  /** Set while the server's studio voice can't deliver (and why), so it isn't asked again at once. */
  private studioDown: { kind: VoiceError["kind"]; why: string; since: number } | null = null;
  /** The engine that produced the passage now playing (a stand-in may differ from the chosen one). */
  private spokenBy: Provider = "browser";
  private studioActive = 0;
  private studioQueue: (() => void)[] = [];
  private utterance: SpeechSynthesisUtterance | null = null;

  constructor(private onChange: () => void) {
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.builtin = new BuiltinVoices(onChange);
    this.native = new NativeVoice(onChange);
    this.native.onSlow = () => {
      this.notice = "This phone was too slow for that voice (long pauses), so it switched to the Light phone voice: many times faster. It downloads once (82 MB). You can change it under Voice.";
      onChange();
    };
    if (this.builtin.notice) this.notice = this.builtin.notice;
    this.password = store.get("vb:password") ?? "";
    this.rate = Number(store.get("vb:rate")) || 1;
    try {
      const saved = JSON.parse(store.get(PREFS_KEY) ?? "{}");
      // Characters now get their own voices by default (once; a later choice is kept).
      if (!saved.castV2) {
        saved.singleVoice = false;
        saved.castV2 = true;
        store.set(PREFS_KEY, JSON.stringify(saved));
      }
      this.prefs = { ...DEFAULT_PREFS, ...saved };
    } catch {}
    try {
      const u = JSON.parse(store.get(USAGE_KEY) ?? "null");
      if (u && u.month === monthKey()) this.usage = { month: u.month, cpu: Number(u.cpu) || 0, audio: Number(u.audio) || 0 };
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
      navigator.mediaSession.setActionHandler("nexttrack", () => this.next());
      navigator.mediaSession.setActionHandler("previoustrack", () => this.previous());
    }
    window.setInterval(() => this.watchdog(), 3000);
    window.addEventListener("pagehide", () => this.savePosition());
  }

  // ---------- account / config ----------

  get premium() {
    return this.config?.plan === "premium";
  }

  setConfig(c: AppConfig) {
    this.config = c;
    // Without an AI key there is nothing to ask: split dialogue and narration locally.
    this.aiUnavailable = !c.providers.anthropic;
    // Once: listeners who had the phone voice picked automatically go back to the studio voice.
    if (!store.get("vb:studio-first")) {
      store.set("vb:studio-first", "1");
      if (store.get(ENGINE_KEY) === "native") store.remove(ENGINE_KEY);
    }
    const saved = store.get(ENGINE_KEY) as Provider | null;
    const available = this.availableProviders();
    const fallback = available[0];
    const next = saved && available.includes(saved) ? saved : fallback;
    if (next !== this.provider) {
      this.provider = next;
      this.casting = this.castingByProvider[next] ?? {};
    }
    if (!this.premium) this.soundscape.stop();
    this.recast();
    this.onChange();
  }

  /** Engines this visitor can choose, best first. */
  availableProviders(): Provider[] {
    const p: Provider[] = [];
    if (this.premium && this.config?.providers.elevenlabs) p.push("elevenlabs");
    if (this.premium && this.config?.providers.openai) p.push("openai");
    // The studio voice (full model on the server) sounds best: first choice whenever it's there.
    if (this.config?.providers.studio) p.push("studio");
    // The phone voice: offline / when the monthly allowance is used up (it also stands in by itself).
    if (this.native?.available) p.push("native");
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
    const regroup = p.singleVoice !== undefined && p.singleVoice !== this.prefs.singleVoice;
    this.prefs = { ...this.prefs, ...p };
    store.set(PREFS_KEY, JSON.stringify(this.prefs));
    this.soundscape.setVolume(this.prefs.bgVolume);
    if (p.music !== undefined && p.music !== "always") this.soundscape.setMusic("none");
    if (regroup) {
      // Passages are grouped differently now: start the current one again.
      this.loadedKey = "";
      this.snap(this.index);
      if (this.playing) return void this.playCurrent();
    } else if (this.playing) {
      const now = this.passageAt(this.index);
      if (now) this.applySound(now, false);
    }
    this.onChange();
  }

  // ---------- studio voice allowance ----------

  private monthUsage(): Usage {
    if (this.usage.month !== monthKey()) this.usage = { month: monthKey(), cpu: 0, audio: 0 };
    return this.usage;
  }

  /** Server time this device may use per month, in seconds (0 = no limit). */
  get studioLimit(): number {
    return Math.max(0, (this.config?.studioMonthlyHours ?? 3) * 3600);
  }

  get studioUsedUp(): boolean {
    return this.studioLimit > 0 && this.monthUsage().cpu >= this.studioLimit;
  }

  /** For the interface: what this device has used of the monthly studio-voice allowance. */
  studioUsage(): { audioMinutes: number; fraction: number; limited: boolean } {
    const u = this.monthUsage();
    return {
      audioMinutes: Math.round(u.audio / 60),
      fraction: this.studioLimit ? Math.min(1, u.cpu / this.studioLimit) : 0,
      limited: this.studioLimit > 0,
    };
  }

  private countUsage(cpu: number, audio: number) {
    const u = this.monthUsage();
    u.cpu += cpu;
    u.audio += audio;
    store.set(USAGE_KEY, JSON.stringify(u));
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
    this.author = book.author ?? "";
    this.folder = book.folder ?? "";
    this.manualVoices = new Set(book.manualVoices ?? []);
    if (!book.scanned) this.prescan(book);
    this.meta = book.meta ?? { genre: "", language: "", narrationStyle: "" };
    this.castingByProvider = book.casting ?? {};
    this.accents = book.accents ?? {};
    this.tweaks = book.tweaks ?? {};
    this.scenes.clear();
    this.aiUsed = false;
    this.error = null;
    this.notice = null;
    this.storageFull = false;
    this.lastMusic = null;
    if (this.studioDown?.kind !== "limit") this.studioDown = null;
    // Every book starts on the listener's preferred engine again (a fallback is per book).
    const preferred = store.get(ENGINE_KEY) as Provider | null;
    const available = this.availableProviders();
    this.provider = preferred && available.includes(preferred) ? preferred : available[0];
    this.casting = this.castingByProvider[this.provider] ?? {};
    this.recast();
    this.justOpened = true;
    const pos = book.position ?? { chunk: 0, offset: 0 };
    this.startAt(Math.min(pos.chunk, this.chunks.length - 1), pos.offset);
    void this.aiCast(book);
    library.patch(book.id, { openedAt: Date.now() });
    library.countAudio(book.id).then((n) => {
      if (this.bookId !== book.id) return;
      this.savedPassages = n;
      this.onChange();
    });
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
    this.epoch++;
    this.onChange();
  }

  /** Forget the saved audio of the open book (frees space; it is generated again when needed). */
  async clearSavedAudio() {
    if (!this.bookId) return;
    await library.clearAudio(this.bookId);
    this.savedPassages = 0;
    this.storageFull = false;
    this.onChange();
  }

  private startAt(chunk: number, offset: number) {
    this.gen++;
    this.token++;
    this.epoch++;
    this.segments = [];
    this.groupEnd = 0;
    this.index = 0;
    this.analyzedUpTo = Math.max(0, chunk) - 1;
    this.analyzePromise = null;
    this.analyzing = false;
    this.pendingOffset = offset;
    this.loadedKey = "";
    this.lastMusic = null;
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

  // ---------- voices ----------

  voicesFor(p: Provider = this.provider): VoiceOption[] {
    if (p === "studio") return STUDIO_VOICES;
    if (p === "builtin") return this.builtin.voices;
    if (p === "native") return STUDIO_VOICES;
    if (p === "openai") return this.config?.voices.openai ?? [];
    if (p === "elevenlabs") return this.config?.voices.elevenlabs ?? [];
    // Device voices: only the best-quality reading voices. English first; another
    // language only when the book itself is in that language.
    const lang = this.meta.language;
    const good = this.browserVoices.filter((v) => !v.fun);
    const inLang = (l: string) => good.filter((v) => v.lang?.toLowerCase().startsWith(l));
    const pool = lang && !lang.startsWith("en") && inLang(lang).length ? inLang(lang) : inLang("en");
    const list = pool.length ? pool : good;
    const top = list.filter((v) => v.name.startsWith("★"));
    return top.length ? top : list.slice(0, 4);
  }

  /** True when one voice reads the whole book. */
  get oneVoice() {
    return this.prefs.singleVoice;
  }

  setTweak(speaker: string, t: Partial<VoiceTweak>) {
    const cur = this.tweaks[speaker] ?? { pitch: 1, speed: 1 };
    this.tweaks = { ...this.tweaks, [speaker]: { ...cur, ...t } };
    this.saveBookState();
    this.onChange();
  }

  // ---------- Casting shared by a series (same author, or same folder) ----------

  private seriesKey(): string | null {
    if (this.author.trim()) return `a:${this.author.trim().toLowerCase()}`;
    if (this.folder.trim()) return `f:${this.folder.trim().toLowerCase()}`;
    return null;
  }

  private seriesAll(): Record<string, Record<string, { voice?: string; gender?: string; age?: string; aliases?: string[] }>> {
    try {
      return JSON.parse(store.get("vb:series") ?? "{}");
    } catch {
      return {};
    }
  }

  /** Characters (and their voices) already met in other books of this author/series. */
  seriesCast() {
    const k = this.seriesKey();
    return k ? this.seriesAll()[k] ?? {} : {};
  }

  private seriesMatch(ch: Character) {
    const names = [ch.name, ...(ch.aliases ?? [])].map((n) => n.toLowerCase());
    for (const [name, v] of Object.entries(this.seriesCast()))
      if (names.includes(name.toLowerCase()) || v.aliases?.some((a) => names.includes(a.toLowerCase()))) return v;
    return undefined;
  }

  /** Remember this book's voices for the next books of the same author/series. */
  private saveSeries() {
    const k = this.seriesKey();
    if (!k) return;
    const all = this.seriesAll();
    const mine = all[k] ?? {};
    const studio = this.castingByProvider.studio ?? (this.provider === "studio" ? this.casting : {});
    for (const ch of this.characters) {
      if (/^Speaker [AB]$/.test(ch.name)) continue;
      const voice = studio[ch.name] ?? this.casting[ch.name];
      if (!voice) continue;
      mine[ch.name] = { voice, gender: ch.gender, age: ch.age, aliases: ch.aliases };
    }
    all[k] = mine;
    store.set("vb:series", JSON.stringify(all));
  }

  /** Voices chosen before (series) or by the AI casting fill in before the automatic casting. */
  private seedCasting() {
    const ids = new Set(this.voicesFor().map((v) => v.id));
    for (const ch of this.characters) {
      if (this.casting[ch.name]) continue;
      const v = this.seriesMatch(ch)?.voice ?? ch.voice;
      if (v && ids.has(v)) this.casting = { ...this.casting, [ch.name]: v };
    }
  }

  /**
   * The AI reads what the on-device scan found and returns the real cast: nicknames merged,
   * man/woman, age, personality, voice. Done once per book (needs an AI key on the server).
   */
  private async aiCast(book: BookRecord) {
    if (book.aiCast || !this.config?.providers.anthropic) return;
    const scanned = this.characters.filter((c) => !/^Speaker [AB]$/.test(c.name));
    if (!scanned.length) return;
    this.casting_ai = true;
    this.onChange();
    try {
      const series = Object.entries(this.seriesCast()).map(([name, v]) => ({ name, ...v }));
      const r = await fetch(api("/api/cast"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: timeoutSignal(50_000),
        body: JSON.stringify({
          title: book.title,
          author: book.author,
          sample: book.chunks.slice(0, 3).join("\n\n").slice(0, 7000),
          series,
          candidates: scanned.slice(0, 40).map((c) => ({ name: c.name, lines: c.lines, gender: c.gender, samples: (c as { samples?: string[] }).samples })),
        }),
      });
      if (!r.ok || this.bookId !== book.id) return;
      const { characters } = (await r.json()) as { characters: Character[] };
      if (!characters?.length || this.bookId !== book.id) return;
      // Lines spoken: add up every name the AI merged into one person.
      for (const c of characters) {
        const names = new Set([c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase()));
        c.lines = scanned.filter((s) => names.has(s.name.toLowerCase())).reduce((a, s) => a + (s.lines ?? 0), 0);
        if (!c.aliases?.length) delete c.aliases;
      }
      const rank = { main: 0, supporting: 1, minor: 2 } as const;
      characters.sort((a, b) => rank[a.importance ?? "supporting"] - rank[b.importance ?? "supporting"] || (b.lines ?? 0) - (a.lines ?? 0));
      // Lines already split under a nickname now belong to the person.
      const canonical = new Map<string, string>();
      for (const c of characters) for (const a of [c.name, ...(c.aliases ?? [])]) canonical.set(a.toLowerCase(), c.name);
      for (const seg of this.segments) {
        const to = canonical.get(seg.speaker.toLowerCase());
        if (to) seg.speaker = to;
      }
      this.characters = [...characters, ...this.characters.filter((c) => /^Speaker [AB]$/.test(c.name))];
      // The AI's voices replace the automatic ones (not the ones the listener chose: those are kept per name).
      const keep = Object.fromEntries(Object.entries(this.casting).filter(([n]) => n === "Narrator" || this.manualVoices.has(n)));
      this.casting = keep;
      this.recast();
      this.loadedKey = "";
      this.saveBookState();
      this.saveSeries();
      await library.patch(book.id, { characters: this.characters, aiCast: true });
      this.snap(this.index);
    } catch {
      // No connection or AI busy: the on-device scan's cast stays; tried again next time.
    } finally {
      this.casting_ai = false;
      this.onChange();
    }
  }

  private recast() {
    this.seedCasting();
    this.casting = castVoices(this.characters, this.voicesFor(), this.meta.genre || "other", this.casting);
    this.castSystemVoice();
    this.castingByProvider = { ...this.castingByProvider, [this.provider]: this.casting };
    for (const ch of this.characters) if (!(ch.name in this.accents)) this.accents[ch.name] = ch.accent ?? "";
  }

  /**
   * Game messages ([You have suffered a deep wound. HP -122.]) get their own crisp voice,
   * never the narrator's, chosen once and kept. Nobody else's voice changes.
   */
  private castSystemVoice() {
    const voices = this.voicesFor();
    if (!voices.length || voices.some((v) => v.id === this.casting[SYSTEM_SPEAKER])) return;
    const narrator = this.casting.Narrator;
    const taken = new Set(Object.entries(this.casting).filter(([k]) => k !== SYSTEM_SPEAKER).map(([, v]) => v));
    const prefs = ["af_nova", "bf_lily", "af_sky", "am_echo", "bm_lewis"];
    const pick =
      prefs.map((id) => voices.find((v) => v.id === id && v.id !== narrator && !taken.has(v.id))).find(Boolean) ??
      voices.find((v) => v.id !== narrator && !taken.has(v.id) && !v.fun) ??
      voices.find((v) => v.id !== narrator) ??
      voices[0];
    this.casting = { ...this.casting, [SYSTEM_SPEAKER]: pick.id };
  }

  /** Read the whole book once to know its characters before the first line is spoken. */
  private prescan(book: BookRecord) {
    let found: ReturnType<typeof scanCharacters> = [];
    try {
      found = scanCharacters(book.chunks);
    } catch {
      return;
    }
    const byName = new Map(this.characters.filter((c) => !(found.length && /^Speaker [AB]$/.test(c.name))).map((c) => [c.name.toLowerCase(), c]));
    for (const c of found) {
      const known = byName.get(c.name.toLowerCase());
      if (known) known.lines = c.lines;
      else byName.set(c.name.toLowerCase(), c);
    }
    this.characters = [...byName.values()].sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0));
    library.patch(book.id, { characters: this.characters, scanned: true });
  }

  character(name: string) {
    return this.characters.find((c) => c.name === name);
  }

  // ---------- analysis ----------

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
          // Never hold the reading up for long: after a while the quick on-device analysis is used.
          const waiting = this.segments.length === 0 || (this.playing && this.index >= this.segments.length);
          const r = await fetch(api("/api/analyze"), {
            signal: timeoutSignal(waiting ? 12_000 : 40_000),
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
          /* no connection: fall back for this part */
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
    if ((this.provider === "studio" || this.provider === "builtin" || this.provider === "native") && this.meta.language && !this.meta.language.toLowerCase().startsWith("en")) {
      // The studio voice only speaks English for now.
      this.setProvider("browser", false);
      this.notice = `The studio voice only reads English for now, so this ${this.meta.language.toUpperCase()} book is read by your device's own voice.`;
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
    const segs: RawSegment[] = a.segments.map((s) => ({
      ...s,
      speaker: s.speaker === "Narrator" ? s.speaker : byName.get(s.speaker.toLowerCase())?.name ?? s.speaker,
    }));
    markParagraphs(segs, this.chunks[c] ?? "");
    this.characters = [...byName.values()];
    for (const s of segs) {
      // Sound words (*SNIKT*, BOOM!) become sound effects; [game messages] get a chime and
      // the system voice. Everything else is read by the line's own speaker as before.
      const parts = splitEffects(s.text);
      const cut = parts.length > 1;
      const spoken = s.speaker !== "Narrator";
      const texts = parts.filter((x) => x.kind === "text").length;
      let seenText = 0;
      parts.forEach((part, n) => {
        const base = { ...s, para: n === 0 ? s.para : false, sfx: n === 0 ? s.sfx : "", chunk: c, cont: cut || undefined };
        if (part.kind === "fx") {
          this.segments.push({ ...base, speaker: FX_SPEAKER, text: part.text, fx: part.fx, emotion: "neutral", quote: 0, id: `${c}-${this.segments.length}` });
          return;
        }
        if (part.kind === "system") {
          this.segments.push({ ...base, speaker: FX_SPEAKER, text: "", fx: "chime", emotion: "neutral", quote: 0, id: `${c}-${this.segments.length}` });
          this.segments.push({ ...base, para: false, speaker: SYSTEM_SPEAKER, text: part.text, emotion: "neutral", quote: 0, id: `${c}-${this.segments.length}` });
          return;
        }
        const first = seenText === 0, last = ++seenText === texts;
        const pieces = part.text.length <= MAX_SEGMENT ? [part.text] : splitSentences(part.text, MAX_SEGMENT);
        pieces.forEach((text, k) =>
          this.segments.push({
            ...base,
            text,
            para: k === 0 ? base.para : false,
            sfx: k === 0 ? base.sfx : "",
            quote: spoken ? (first && k === 0 ? 1 : 0) + (last && k === pieces.length - 1 ? 2 : 0) : 0,
            id: `${c}-${this.segments.length}`,
          }),
        );
      });
    }
    this.analyzedUpTo = c;
    this.recast();
    if (this.pendingOffset !== null) {
      this.snap(Math.min(this.pendingOffset, Math.max(0, this.segments.length - 1)));
      this.pendingOffset = null;
      this.savePosition();
      if (this.justOpened) {
        this.justOpened = false;
        this.prepare();
      }
    } else if (this.playing) {
      const now = this.passageAt(this.index);
      if (now) this.prepareAhead(now);
    }
    this.saveBookState();
  }

  // ---------- passages ----------

  /** A title or chapter heading: read on its own, with a pause after it. */
  isHeading(s: Segment) {
    if (s.speaker !== "Narrator" || s.cont) return false;
    return /heading/i.test(s.delivery ?? "") || (s.text.length < 80 && !/[.!?…"”»,;:]$/.test(s.text.trim()));
  }

  /** Last line of the passage that starts at line `s`. */
  private runFrom(s: number, limit: number): number {
    const segs = this.segments;
    const first = segs[s];
    if (this.isHeading(first) || first.fx) return s;
    let len = first.text.length;
    let j = s;
    for (;;) {
      const n = segs[j + 1];
      if (!n || n.chunk !== first.chunk || this.isHeading(n)) break;
      if (n.fx || ((!this.oneVoice || special(n) || special(first)) && n.speaker !== first.speaker)) break;
      if (len + 1 + n.text.length > limit) break;
      if (n.para && len >= limit * 0.5) break; // a paragraph end is the best place to breathe
      len += 1 + n.text.length;
      j++;
    }
    return j;
  }

  /**
   * First and last line of the passage containing line `i`. Passages are always cut the
   * same way from the start of a part of the book, so saved audio is found again.
   */
  private bounds(i: number): [number, number] {
    const segs = this.segments;
    const seg = segs[i];
    const limit = PASSAGE_CHARS[this.provider];
    if (!seg || !limit) return [i, i];
    const ramp = this.provider === "studio" || this.provider === "builtin" || this.provider === "native";
    let s = i;
    while (s > 0 && segs[s - 1].chunk === seg.chunk) s--;
    for (let n = 0; ; ) {
      const heading = this.isHeading(segs[s]);
      const e = this.runFrom(s, ramp && !heading ? Math.min(limit, RAMP[n] ?? limit) : limit);
      if (i <= e) return [s, e];
      if (!heading) n++;
      s = e + 1;
    }
  }

  private pauseAfter(last: Segment, next?: Segment): number {
    if (last.fx) return 0; // the effect carries its own short pause
    if (next?.fx) return next.fx === "chime" ? 380 : 220;
    if (this.isHeading(last)) return 750;
    if (!next || next.chunk !== last.chunk || this.isHeading(next)) return 800;
    let ms = next.para ? 600 : 320;
    if (/(…|\.\.\.)["”»]?$/.test(last.text.trim())) ms = Math.max(ms, 520);
    if (!this.oneVoice && next.speaker !== last.speaker) ms = Math.max(ms, 380);
    if ((next.tags ?? []).some((t) => /pause/i.test(t))) ms += 400;
    return ms;
  }

  private keyOf(provider: Provider, voice: string, text: string, tailMs: number, seg: Segment): string {
    if (provider === "studio") return `studio|${voice}|${tailMs}|${hash53(text)}`;
    if (provider === "builtin") return `builtin-${this.builtin.tier}|${voice}|${hash53(text)}`;
    if (provider === "native") return `native2-${this.native.tier}|${voice}|${hash53(text)}`; // 2: without the whistle
    if (provider === "browser") return `${provider}|${voice}|${hash53(text)}`;
    // Acting voices: everything that changes the performance is part of the identity.
    const acting = [seg.emotion, seg.delivery ?? "", (seg.tags ?? []).join(","), seg.intensity ?? 1, this.accents[seg.speaker] ?? ""].join("~");
    return `${provider}|${voice}|${hash53(`${text}\u0000${acting}`)}`;
  }

  /** The passage that contains line `i`, ready to be spoken. */
  passageAt(i: number): Passage | null {
    if (!this.segments[i]) return null;
    const [start, end] = this.bounds(i);
    const first = this.segments[start];
    const speaker = this.oneVoice && !special(first) ? "Narrator" : first.speaker;
    const voice = first.fx ? "" : this.casting[speaker] ?? this.casting.Narrator ?? "";
    if (first.fx) return { start, end, speaker, voice, text: first.text, tailMs: 0, seg: first, key: `fx|${first.fx}|${first.text}` };
    const whole = PASSAGE_CHARS[this.provider] > 0;
    let text = "";
    for (let k = start; k <= end; k++) {
      const s = this.segments[k];
      let line = s.text.trim();
      // One voice reading dialogue: put the quotation marks back so it is voiced as speech.
      if (whole && this.oneVoice && s.quote) line = `${s.quote & 1 ? "“" : ""}${line}${s.quote & 2 ? "”" : ""}`;
      text += (k === start ? "" : s.para ? "\n" : " ") + line;
    }
    const tailMs = this.pauseAfter(this.segments[end], this.segments[end + 1]);
    return { start, end, speaker, voice, text, tailMs, seg: first, key: this.keyOf(this.provider, voice, text, tailMs, first) };
  }

  /** Point at the start of the passage containing line `i`. */
  private snap(i: number) {
    const p = this.passageAt(i);
    this.index = p ? p.start : Math.max(0, i);
    this.groupEnd = p ? p.end : this.index;
  }

  // ---------- getting a passage spoken ----------

  private audioFor(p: Passage, lookAhead = false): Promise<string> {
    if (p.seg.fx) {
      this.ready.add(p.key);
      return Promise.resolve(fxUrl(p.seg.fx as FxKind, p.text));
    }
    let job = this.cache.get(p.key);
    if (job) return job;
    const provider = this.provider;
    const bookId = this.bookId;
    const epoch = this.epoch;
    // Saved for next time, except on-computer audio (free to redo, and large) and voice samples.
    const keep = provider !== "builtin" && !!bookId && !p.key.startsWith("preview|");
    job = (async () => {
      const saved = keep ? await library.getAudio(bookId, p.key) : undefined;
      if (saved) return URL.createObjectURL(new Blob([saved.buf], { type: saved.type }));
      const blob = await this.generate(provider, p, lookAhead, epoch);
      if (keep && !this.storageFull) {
        blob
          .arrayBuffer()
          .then((buf) => library.putAudio(bookId, p.key, { type: blob.type || "audio/mpeg", buf }))
          .then((ok) => {
            if (!ok) this.storageFull = true;
            else if (this.bookId === bookId) this.savedPassages++;
          })
          .catch(() => {});
      }
      return URL.createObjectURL(blob);
    })();
    job.then(() => { this.ready.add(p.key); this.onChange(); }, () => this.cache.delete(p.key));
    this.cache.set(p.key, job);
    return job;
  }

  /** Passages whose audio is ready (for the "ready ahead" count). */
  private ready = new Set<string>();
  /** Learned seconds needed per character of text, per engine (for the progress %). */
  private secPerChar: Partial<Record<Provider, number>> = { studio: 0.03, builtin: 0.05, elevenlabs: 0.01, openai: 0.01 };

  private async generate(provider: Provider, p: Passage, lookAhead: boolean, epoch: number): Promise<Blob> {
    const started = Date.now();
    const blob = await this.generateRaw(provider, p, lookAhead, epoch);
    const per = (Date.now() - started) / 1000 / Math.max(40, p.text.length);
    const old = this.secPerChar[provider] ?? per;
    if (per < old * 4) this.secPerChar[provider] = old * 0.6 + per * 0.4; // queued waits are not counted fully
    return blob;
  }

  private async generateRaw(provider: Provider, p: Passage, lookAhead: boolean, epoch: number): Promise<Blob> {
    if (provider === "builtin") return this.builtin.generate(p.text, p.voice, 1);
    if (provider === "native") return this.native.generate(p.text, p.voice, 1);
    if (provider === "studio") return this.studioSlot(() => this.studioRequest(p), lookAhead, epoch);

    const seg = p.seg;
    const r = await fetch(api("/api/tts"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        provider,
        voice: p.voice,
        text: p.text,
        emotion: seg.emotion,
        delivery: seg.delivery,
        tags: seg.tags,
        intensity: seg.intensity,
        prevText: this.segments[p.start - 1]?.text,
        nextText: this.segments[p.end + 1]?.text,
        speaker: seg.speaker,
        character: this.character(seg.speaker),
        genre: this.meta.genre,
        narrationStyle: this.meta.narrationStyle,
        language: this.meta.language,
        accent: this.accents[seg.speaker] || undefined,
      }),
    });
    if (r.status === 402) this.premiumPrompt = true;
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `Voice error ${r.status}`);
    return r.blob();
  }

  /**
   * At most two studio requests at a time. Look-ahead work that is still waiting when the
   * listener moves elsewhere is dropped; the passage being waited for never queues.
   */
  private async studioSlot<T>(job: () => Promise<T>, lookAhead: boolean, epoch: number): Promise<T> {
    if (lookAhead && this.studioActive >= 2) {
      await new Promise<void>((go) => this.studioQueue.push(go));
      if (epoch !== this.epoch) {
        this.studioQueue.shift()?.();
        throw new VoiceError("stale", "no longer needed");
      }
    }
    this.studioActive++;
    try {
      return await job();
    } finally {
      this.studioActive--;
      this.studioQueue.shift()?.();
    }
  }

  private async studioRequest(p: Passage): Promise<Blob> {
    const down = this.studioDown;
    if (down && (down.kind === "limit" ? this.studioUsedUp : Date.now() - down.since < (down.kind === "offline" ? 40_000 : RETRY_MS))) throw new VoiceError(down.kind, down.why);
    try {
      if (this.studioUsedUp) throw new VoiceError("limit", "this month's free studio-voice allowance is used up");
      let r: Response | null = null;
      // A server restarting (an update) or a moment without signal: try again before giving up.
      for (const wait of [0, 4000, 12000]) {
        if (wait) await new Promise((ok) => setTimeout(ok, wait));
        try {
          r = await fetch(api("/api/voice"), {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ text: p.text, voice: p.voice || "af_heart", tailMs: p.tailMs }),
            signal: timeoutSignal(295_000),
          });
          if (r.status < 502 || r.status > 504) break;
        } catch {
          r = null;
        }
      }
      if (!r) throw new VoiceError("offline", "the server can't be reached");
      if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("audio/")) {
        const info = await r.json().catch(() => null);
        const reason = typeof info?.error === "string" ? info.error : `the server answered with error ${r.status}`;
        throw new VoiceError("server", reason);
      }
      const blob = await r.blob();
      this.countUsage(
        Number(r.headers.get("x-cpu-seconds")) || Number(r.headers.get("x-took-seconds")) || 0,
        Number(r.headers.get("x-audio-seconds")) || 0,
      );
      this.studioReady = true;
      if (this.studioDown) {
        // It is back.
        this.studioDown = null;
        this.notice = null;
      }
      return blob;
    } catch (e) {
      const err = e instanceof VoiceError ? e : new VoiceError("server", e instanceof Error ? e.message : String(e));
      this.studioDown = { kind: err.kind, why: err.message, since: Date.now() };
      const standIn = this.builtin.available ? "the on-device AI voice fills in" : "your device's own voice fills in";
      this.notice =
        err.kind === "limit"
          ? `This month's free studio-voice allowance is used up on this device. Passages already saved still play in the studio voice; for new ones ${standIn} until next month.`
          : `The studio voice isn't available right now (${err.message}). Saved passages still play; for new ones ${standIn}. It will be tried again in ${err.kind === "offline" ? "less than a minute" : "a couple of minutes"}.`;
      throw err;
    }
  }

  /** Get the passages at the reading position ready before play is pressed. */
  private prepare() {
    if (this.provider !== "studio" || this.studioUsedUp || document.visibilityState !== "visible") return;
    const p = this.passageAt(this.index);
    if (!p) return;
    this.audioFor(p).catch(() => {});
    this.prepareAhead(p);
  }

  /**
   * Keep the next passages ready while the current one plays. They are prepared one after
   * the other (nearest first), each starting as soon as the previous is ready, so the
   * buffer refills continuously instead of only when a new passage begins.
   */
  private prepareAhead(p: Passage) {
    const want = AHEAD[this.provider];
    if (!want) return;
    const epoch = this.epoch;
    const provider = this.provider;
    const step = (from: number, left: number) => {
      if (left <= 0 || epoch !== this.epoch || provider !== this.provider) return;
      const q = this.passageAt(from);
      if (!q) return; // the rest of the book isn't read yet: prepareAhead runs again when it is
      this.audioFor(q, true).then(
        () => step(q.end + 1, left - (q.seg.fx ? 0 : 1)), // effects are instant: they don't use up the look-ahead
        () => {},
      );
    };
    step(p.end + 1, want);
    // The server can make two at once: start the second-nearest in parallel too.
    if (provider === "studio" || provider === "elevenlabs" || provider === "openai") {
      const first = this.passageAt(p.end + 1);
      const second = first && this.passageAt(first.end + 1);
      if (second) this.audioFor(second, true).catch(() => {});
    }
  }

  // ---------- sound effects & background ----------

  private get sfxOn() {
    return this.premium && this.prefs.sfx && !!this.config?.providers.elevenlabs;
  }

  private sfxFor(desc: string): Promise<string> {
    let p = this.sfxCache.get(desc);
    if (!p) {
      p = fetch(api("/api/sfx"), { method: "POST", headers: this.headers(), body: JSON.stringify({ text: desc }) }).then(async (r) => {
        if (!r.ok) throw new Error("sfx");
        return URL.createObjectURL(await r.blob());
      });
      p.catch(() => this.sfxCache.delete(desc));
      this.sfxCache.set(desc, p);
    }
    return p;
  }

  private playSfx(p: Passage, t: number) {
    if (!this.sfxOn) return;
    const desc = this.segments.slice(Math.max(0, p.start), p.end + 1).find((s) => s.sfx)?.sfx;
    if (!desc) return;
    this.sfxFor(desc)
      .then((url) => {
        if (t !== this.token) return;
        const a = new Audio(url);
        a.volume = Math.min(1, 0.35 + this.prefs.bgVolume * 0.6);
        a.play().catch(() => {});
      })
      .catch(() => {});
  }

  private sceneFor(chunk: number): Scene {
    for (let c = chunk; c >= 0; c--) {
      const s = this.scenes.get(c);
      if (s) return s;
    }
    return { ambience: "none", music: "none" };
  }

  /**
   * Background sound for a passage. Ambience follows the scene. Music, unless asked for
   * all the time, only plays for a moment: a chapter opening, a change of mood, an intense line.
   */
  private applySound(p: Passage, starting = true) {
    if (!this.premium) return this.soundscape.stop();
    const chunk = p.seg.chunk;
    const scene = this.sceneFor(chunk);
    this.soundscape.setAmbience(this.prefs.ambience ? scene.ambience : "none");

    if (this.prefs.music === "always") this.soundscape.setMusic(scene.music);
    else if (this.prefs.music === "moments" && starting) {
      const firstOfPart = p.start === 0 || this.segments[p.start - 1]?.chunk !== chunk;
      const chapterOpening = firstOfPart && this.chapters.some((c) => c.chunk === chunk);
      const moodChanged = !!this.lastMusic && this.lastMusic.chunk !== chunk && this.lastMusic.mood !== scene.music;
      const intense = this.segments.slice(p.start, p.end + 1).find((s) => (s.intensity ?? 1) >= 3);
      if (scene.music !== "none" && (chapterOpening || moodChanged)) this.soundscape.musicMoment(scene.music, chapterOpening ? 22 : 30);
      else if (intense) this.soundscape.musicMoment(MOOD_FOR[intense.emotion] ?? (scene.music !== "none" ? scene.music : "tense"), 20);
    }
    if (starting) this.lastMusic = { chunk, mood: scene.music };
  }

  // ---------- playback ----------

  private unlock() {
    this.soundscape.unlock();
    if (this.unlocked) return;
    this.unlocked = true;
    if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    // Playing (silence) from the tap itself is what lets the player start by itself later.
    this.holdAudioSession(false);
  }

  /**
   * Play silence on the player. Looped while audio is being prepared, so a phone with
   * its screen off keeps the page running until the passage is ready.
   */
  private stuckSince = 0;
  /**
   * Safety net: if the phone stopped the sound on its own, start it again; if a passage has
   * been "loading" for too long, ask for it again.
   */
  private watchdog() {
    if (!this.playing || this.provider === "browser" || this.previewing) {
      this.stuckSince = 0;
      return;
    }
    const a = this.audio;
    if (!this.buffering && a.paused && !a.ended && a.src) {
      a.play().catch(() => {
        this.notice = "Your phone paused the sound. Tap ▶ to carry on.";
        this.playing = false;
        this.onChange();
      });
      return;
    }
    if (this.buffering) {
      this.stuckSince ||= Date.now();
      if (a.paused && this.unlocked) this.holdAudioSession(); // keep the phone's audio session alive
      if (Date.now() - this.stuckSince > 75_000) {
        this.stuckSince = 0;
        this.playCurrent(); // try again: saved or freshly made audio
      }
    } else this.stuckSince = 0;
  }

  private gaps = new Map<number, string>();
  /** A short silence (rounded to 50 ms), made once and reused. */
  private gapUrl(ms: number): string {
    const k = Math.max(50, Math.round(ms / 50) * 50);
    let u = this.gaps.get(k);
    if (!u) this.gaps.set(k, (u = silentWavUrl(k / 1000)));
    return u;
  }

  private holdAudioSession(loop = true) {
    if (!this.unlocked || (loop && this.provider === "browser")) return;
    this.silent ||= silentWavUrl(6);
    const a = this.audio;
    a.onended = null;
    a.onerror = null;
    a.loop = loop;
    a.src = this.silent;
    a.play().catch(() => {});
  }

  play() {
    if (this.previewing) this.previewing = "";
    if (this.premium) this.soundscape.unlock();
    const now = this.passageAt(this.index);
    if (this.provider !== "browser" && now && this.loadedKey === now.key && this.audio.currentTime > 0 && !this.audio.ended) {
      // Carry on in the middle of the passage.
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
    this.waitingSince = 0;
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

  /** Go to the passage containing line `i`. */
  jump(i: number) {
    this.epoch++;
    this.lastMusic = null;
    this.loadedKey = "";
    this.snap(Math.max(0, Math.min(i, Math.max(0, this.segments.length - 1))));
    if (this.playing) this.playCurrent();
    else {
      this.savePosition();
      this.onChange();
    }
  }

  next() {
    this.jump(Math.max(this.index, this.groupEnd) + 1);
  }

  previous() {
    this.jump(this.index - 1);
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
    this.epoch++;
    this.provider = p;
    this.loadedKey = "";
    if (remember && p === "studio" && this.studioDown?.kind !== "limit") this.studioDown = null; // choosing it again = try again now
    if (remember) store.set(ENGINE_KEY, p);
    if (p === "builtin") this.builtin.warm(this.casting.Narrator);
    if (p === "native") this.native.download();
    this.casting = this.castingByProvider[p] ?? {};
    this.recast();
    this.snap(this.index);
    this.saveBookState();
    this.onChange();
  }

  /**
   * Free memory: drop audio kept in memory (except what's playing and the next passage),
   * and close voice engines that aren't in use right now.
   */
  freeMemory() {
    const keep = new Set<string>();
    const cur = this.passageAt(this.index);
    if (cur) {
      keep.add(cur.key);
      const next = this.passageAt(cur.end + 1);
      if (next) keep.add(next.key);
    }
    for (const k of [...this.cache.keys()]) if (!keep.has(k)) {
      this.cache.delete(k);
      this.ready.delete(k);
    }
    if (this.provider !== "builtin") this.builtin.release();
    if (this.provider !== "native" || !this.playing) this.native.freeMemory();
    this.onChange();
  }

  /** Choose the size ("power") of the on-device voice. */
  setBuiltinTier(t: Tier) {
    if (t === this.builtin.tier) return;
    const wasPlaying = this.playing && this.provider === "builtin";
    if (this.provider === "builtin") this.pause();
    this.epoch++;
    this.loadedKey = "";
    this.builtin.setTier(t);
    if (this.provider === "builtin") {
      this.recast();
      this.snap(this.index);
      this.saveBookState();
      this.builtin.warm(this.casting.Narrator);
      if (wasPlaying) this.play();
    }
    this.onChange();
  }

  setDeviceKind(k: DeviceKind) {
    this.builtin.setDevice(k);
  }

  setVoice(speaker: string, voiceId: string) {
    this.casting = { ...this.casting, [speaker]: voiceId };
    this.castingByProvider = { ...this.castingByProvider, [this.provider]: this.casting };
    this.loadedKey = "";
    this.saveBookState();
    this.saveSeries(); // the same character keeps this voice in the next books of the series
    this.manualVoices.add(speaker);
    if (this.bookId) void library.patch(this.bookId, { manualVoices: [...this.manualVoices] });
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

  /** What the listener is waiting for, in words (null when nothing). */
  /** How many passages after the current one are already prepared. */
  get readyAhead(): number {
    if (this.provider === "browser") return 0;
    let n = 0;
    let p = this.passageAt(this.index);
    while (p && n < 9) {
      const q = this.passageAt(p.end + 1);
      if (!q || !this.ready.has(q.key)) break;
      n++;
      p = q;
    }
    return n;
  }

  /** 0–99: an estimate of how far the current wait has come. */
  get waitPercent(): number | null {
    if (!this.buffering) return null;
    const since = this.waitingSince || Date.now();
    const elapsed = (Date.now() - since) / 1000;
    let expect: number;
    if (!this.segments[this.index]) expect = 12; // reading the next part of the book
    else if (this.provider === "builtin" && !this.builtin.ready && this.builtin.progress !== null && this.builtin.progress < 1)
      return Math.round(this.builtin.progress * 100); // the one-time download
    else if (this.provider === "builtin" && !this.builtin.ready) expect = 20; // opening the voice
    else if (this.provider === "native" && !this.native.ready) return Math.round(this.native.progress * 100); // one-time download
    else {
      const p = this.passageAt(this.index);
      const chars = p?.text.length ?? 300;
      expect = (this.provider === "studio" && !this.studioReady ? 30 : 2) + chars * (this.secPerChar[this.provider] ?? 0.04);
    }
    // Moves steadily, slows down near the end instead of stopping at 100.
    const x = elapsed / Math.max(1, expect);
    return Math.min(99, Math.round(x < 0.85 ? x * 100 : 85 + 14 * (1 - Math.exp(-(x - 0.85) * 2))));
  }

  get waitMessage(): string | null {
    if (!this.buffering) return null;
    if (!this.segments[this.index]) return "Reading the next part of the book…";
    if (this.provider === "studio" && !this.studioDown) {
      return this.studioReady ? "Preparing the next passage…" : "Warming up the studio voice. The first time can take up to a minute…";
    }
    if (this.provider === "native") {
      return this.native.ready ? "Making the voice on this phone…" : "Downloading the phone voice (only once)…";
    }
    if (this.provider === "builtin" || this.provider === "studio") {
      if (this.builtin.ready) return "Making the voice on this device…";
      const pct = Math.round((this.builtin.progress ?? 0) * 100);
      return pct >= 100 || this.builtin.available
        ? "Getting the voice ready on this device…"
        : `Downloading the voice to this device (${this.builtin.tier === "light" ? "63" : this.builtin.tier === "best" ? "326" : "92"} MB, only once)…`;
    }
    return "Preparing the voice…";
  }

  private fail(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e);
    this.playing = false;
    this.buffering = false;
    this.audio.pause();
    this.soundscape.pause();
    this.onChange();
  }

  /** The on-computer voice can't deliver: carry on with the device's own voice. False if there is none. */
  private fallBack(e: unknown): boolean {
    if (this.provider !== "builtin" && this.provider !== "native") return false;
    const why = e instanceof Error ? e.message : String(e);
    // Prefer the studio voice (online, best quality) when it can be used.
    if (this.availableProviders().includes("studio") && !this.studioUsedUp && !(this.studioDown && Date.now() - this.studioDown.since < RETRY_MS)) {
      this.setProvider("studio", false);
      this.notice = `The ${this.provider === "native" ? "phone" : "on-device AI"} voice couldn't run (${why}), so the studio voice is reading instead (needs a connection).`;
      return true;
    }
    if (!this.browserVoices.length) return false;
    this.setProvider("browser", false);
    this.notice = `The on-device AI voice couldn't run (${why}), so your device's own voice is reading.`;
    return true;
  }

  /**
   * The server's studio voice can't deliver this passage: read just this one another way
   * (made on this computer if it can, else the device's own voice). The studio voice stays
   * the chosen engine, so saved passages keep playing and it is tried again later.
   */
  private async standIn(p: Passage, t: number): Promise<boolean> {
    if (this.native.ready) {
      try {
        this.onChange();
        const blob = await this.native.generate(p.text, p.voice, 1);
        if (t !== this.token) return true;
        await this.startAudio(URL.createObjectURL(blob), p, t, "native");
        return true;
      } catch {
        if (t !== this.token) return true;
      }
    }
    if (this.builtin.available) {
      try {
        this.onChange();
        const blob = await this.builtin.generate(p.text, p.voice, 1);
        if (t !== this.token) return true;
        await this.startAudio(URL.createObjectURL(blob), p, t, "builtin");
        return true;
      } catch {
        if (t !== this.token) return true;
      }
    }
    const voice = this.voicesFor("browser")[0]?.id;
    if (!voice || !("speechSynthesis" in window)) return false;
    this.audio.pause();
    this.buffering = false;
    this.waitingSince = 0;
    this.spokenBy = "browser";
    this.onChange();
    this.speakBrowser({ ...p, voice }, t);
    return true;
  }

  /** Put a passage's audio on the player and start it. */
  private async startAudio(url: string, p: Passage, t: number, by: Provider) {
    const a = this.audio;
    a.loop = false;
    a.src = url;
    a.volume = 1;
    a.defaultPlaybackRate = this.rate;
    a.playbackRate = this.rate;
    this.loadedKey = by === this.provider ? p.key : "";
    this.spokenBy = by;
    a.onended = () => t === this.token && this.advance();
    a.onerror = () => t === this.token && this.fail(new Error("This passage's audio couldn't be played. Tap play to try again."));
    this.playSfx(p, t);
    await a.play();
    if (t !== this.token) return;
    this.buffering = false;
    this.waitingSince = 0;
    this.onChange();
  }

  private async playCurrent() {
    const t = ++this.token;
    this.error = null;
    this.audio.pause();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();

    while (this.index >= this.segments.length) {
      if (this.analyzedUpTo + 1 >= this.chunks.length) {
        // The end of the book.
        this.playing = false;
        this.buffering = false;
        this.snap(Math.max(0, this.segments.length - 1));
        this.soundscape.stop();
        this.onChange();
        return;
      }
      this.buffering = true;
      this.waitingSince ||= Date.now();
      this.onChange();
      this.holdAudioSession();
      await this.analyzeNext();
      if (t !== this.token) return;
    }
    // Keep the next part of the book analysed well ahead, so passages can be prepared across parts.
    if (this.segments.length - this.index < LOOKAHEAD_SEGMENTS * 4) this.analyzeNext();

    const p = this.passageAt(this.index)!;
    this.index = p.start;
    this.groupEnd = p.end;
    this.savePosition();
    this.soundscape.resume();
    this.applySound(p);
    if ("mediaSession" in navigator) {
      const ch = this.chapters[this.currentChapterIndex()];
      navigator.mediaSession.metadata = new MediaMetadata({ title: ch?.title || this.title, artist: this.title, album: "Voicebook" });
      navigator.mediaSession.playbackState = "playing";
    }
    if (this.sfxOn) {
      for (const s of this.segments.slice(p.end + 1, p.end + 6)) if (s.sfx) this.sfxFor(s.sfx).catch(() => {});
    }

    if (p.seg.fx) {
      // A sound effect: made in the app, played at once on the player, whatever the voice.
      this.prepareAhead(p);
      try {
        await this.startAudio(fxUrl(p.seg.fx as FxKind, p.text), p, t, this.provider === "browser" ? "builtin" : this.provider);
      } catch {
        if (t === this.token) this.advance(); // a sound that can't play is simply skipped
      }
      return;
    }

    if (this.provider === "browser") {
      this.buffering = false;
      this.waitingSince = 0;
      this.spokenBy = "browser";
      this.onChange();
      this.playSfx(p, t);
      this.speakBrowser(p, t);
      return;
    }

    this.buffering = true;
    this.waitingSince ||= Date.now();
    this.onChange();
    this.holdAudioSession();
    let url: string;
    try {
      url = await this.audioFor(p);
    } catch (e) {
      if (t !== this.token) return;
      // Dropped as look-ahead while the listener was elsewhere, and now wanted after all: ask again.
      if (e instanceof VoiceError && e.kind === "stale") return void this.playCurrent();
      if (this.provider === "studio") {
        this.prepareAhead(p); // saved passages further on are still wanted
        if (await this.standIn(p, t)) return;
        if (t === this.token) this.fail(e);
      } else if (this.fallBack(e)) {
        this.playing = true;
        this.playCurrent();
      } else this.fail(e);
      return;
    }
    if (t !== this.token) return;
    this.prepareAhead(p);
    try {
      await this.startAudio(url, p, t, this.provider);
      if (t === this.token) this.evictOld(p.key);
    } catch (e) {
      if (t === this.token) this.fail(e);
    }
  }

  private speakBrowser(p: Passage, t: number, onEnd: () => void = () => this.advance()) {
    const synth = window.speechSynthesis;
    const v = synth.getVoices().find((x) => x.voiceURI === p.voice);
    const single = p.start === p.end;
    const prosody = browserProsody(
      single ? p.seg.emotion : "neutral",
      p.speaker === "Narrator" || !this.prefs.characterPitch ? undefined : this.character(p.speaker),
      single ? p.seg.intensity ?? 1 : 1,
      this.prefs.expressiveness,
    );
    const tweak = this.tweaks[p.speaker];
    if (tweak) {
      prosody.pitch = Math.min(2, Math.max(0.1, prosody.pitch * tweak.pitch));
      prosody.rate = Math.min(2.5, Math.max(0.4, prosody.rate * tweak.speed));
    }
    // Voices stored on the device read a whole passage in one breath, which sounds most natural.
    // Only online voices need sentence-sized pieces (some browsers cut them off after ~15 s).
    const pieces = v && v.localService === false ? splitSentences(p.text, 180) : [p.text];
    const speakPiece = (i: number) => {
      if (t !== this.token) return;
      if (i >= pieces.length) return onEnd();
      const u = new SpeechSynthesisUtterance(pieces[i]);
      if (v) u.voice = v;
      u.lang = v?.lang || this.meta.language || "en";
      u.rate = Math.min(4, prosody.rate * this.rate);
      u.pitch = prosody.pitch;
      u.volume = prosody.volume;
      u.onend = () => speakPiece(i + 1);
      u.onerror = (e) => {
        if (t !== this.token || e.error === "interrupted" || e.error === "canceled") return;
        this.fail(new Error(`This device's voice failed (${e.error}). Try another voice in 🎭 Voice.`));
      };
      this.utterance = u; // keep a reference: some browsers drop the "end" event otherwise
      synth.speak(u);
    };
    speakPiece(0);
  }

  private advance() {
    const last = this.segments[Math.max(this.index, this.groupEnd)];
    this.index = Math.max(this.index, this.groupEnd) + 1;
    this.groupEnd = this.index;
    this.loadedKey = "";
    if (!this.playing) return this.onChange();
    // The studio voice has its pause built into the audio, so the next passage starts at
    // once (this also keeps playing reliable on a locked phone). Other engines get a timed gap.
    const gap =
      this.spokenBy === "studio" || !last
        ? 0
        : (this.pauseAfter(last, this.segments[this.index]) * (this.spokenBy === "browser" ? this.prefs.pauses : 0.6)) / Math.max(0.75, this.rate);
    const t = this.token;
    if (!gap) return void this.playCurrent();
    this.onChange();
    if (this.spokenBy !== "browser" && this.unlocked) {
      // The pause is played as silence on the player: timers are slowed down on a locked
      // phone, but audio keeps its pace, so reading goes on with the screen off.
      const a = this.audio;
      a.loop = false;
      a.onerror = () => t === this.token && this.playing && this.playCurrent();
      a.onended = () => t === this.token && this.playing && this.playCurrent();
      a.src = this.gapUrl(gap);
      a.play().catch(() => setTimeout(() => this.playing && t === this.token && this.playCurrent(), gap));
      return;
    }
    setTimeout(() => this.playing && t === this.token && this.playCurrent(), gap);
  }

  // ---------- voice preview ----------

  /** Plays a short sample of the voice currently chosen for `speaker`. */
  async preview(speaker: string) {
    this.pause();
    this.unlock();
    const who = this.oneVoice ? "Narrator" : speaker;
    const voice = this.casting[who] ?? this.casting.Narrator ?? "";
    const fits = (s: Segment) => (this.oneVoice ? s.speaker === "Narrator" : s.speaker === speaker) && !this.isHeading(s);
    const line = this.segments.find((s) => fits(s) && s.text.length > 60 && s.text.length < 170) ?? this.segments.find((s) => fits(s) && s.text.length > 20);
    const seg: Segment = line ?? {
      id: "preview",
      chunk: -1,
      speaker: who,
      emotion: "neutral",
      text: who === "Narrator" ? "Once upon a time, in a quiet town by the sea, a story was waiting to be told." : `Hello. My name is ${speaker}.`,
    };
    const text = seg.text.length > 170 ? splitSentences(seg.text, 170)[0] : seg.text;
    const sample: Passage = { start: -1, end: -1, speaker: who, voice, text, tailMs: 200, seg, key: `preview|${this.keyOf(this.provider, voice, text, 200, seg)}` };
    const t = ++this.token;
    this.previewing = speaker;
    this.error = null;
    this.onChange();
    try {
      if (this.provider === "browser") {
        await new Promise<void>((resolve) => {
          this.speakBrowser(sample, t, resolve);
          setTimeout(resolve, 15000); // safety net if the device never reports the end
        });
      } else {
        this.holdAudioSession();
        const url = await this.audioFor(sample);
        if (t !== this.token) return;
        const a = this.audio;
        a.loop = false;
        a.src = url;
        a.playbackRate = this.rate;
        this.loadedKey = "";
        await new Promise<void>((resolve, reject) => {
          a.onended = () => resolve();
          a.onerror = () => reject(new Error("The sample couldn't be played."));
          a.play().catch(reject);
        });
      }
    } catch (e) {
      if (t === this.token) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (this.previewing === speaker) this.previewing = "";
      if (t === this.token) this.audio.pause();
      this.onChange();
    }
  }

  // ---------- housekeeping ----------

  /** Keep only the most recent audio in memory (saved audio stays on the device). */
  private evictOld(current: string) {
    const keys = [...this.cache.keys()];
    for (const key of keys.slice(0, Math.max(0, keys.length - 10))) {
      if (key === current) continue;
      const job = this.cache.get(key)!;
      this.cache.delete(key);
      this.ready.delete(key);
      job.then((u) => setTimeout(() => URL.revokeObjectURL(u), 1000)).catch(() => {});
    }
  }

  private clearAudioCache() {
    this.cache.forEach((p) => p.then(URL.revokeObjectURL).catch(() => {}));
    this.cache.clear();
    this.ready.clear();
  }

  destroy() {
    this.pause();
    this.soundscape.stop();
    this.clearAudioCache();
  }
}
