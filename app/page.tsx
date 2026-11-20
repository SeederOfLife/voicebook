"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBook, detectSections } from "@/lib/chunk";
import { ReaderEngine } from "@/lib/engine";
import { extractText } from "@/lib/extract";
import { bookId, library, type BookRecord, type BookSummary } from "@/lib/library";
import { getSupabase } from "@/lib/supabase-browser";
import { ACCENTS, type AppConfig, type Provider } from "@/lib/types";
import { hash } from "@/lib/voices";
import { DEVICE_KINDS, TIERS, TIER_ORDER, type DeviceKind, type Tier } from "@/lib/builtin";
import { ANDROID_APK_URL, inAndroidApp, NATIVE_TIERS, type FoundFile, type NativeTier, type ScanResult } from "@/lib/native";
import { LibraryView } from "./library-view";
import { api, asset, findServer } from "@/lib/paths";
import { ShareDialog } from "./share-dialog";
import { StoragePanel } from "./storage-panel";
import { shelfFor } from "@/lib/shelf";

const PROVIDER_LABEL: Record<Provider, string> = {
  studio: "Studio voice",
  elevenlabs: "ElevenLabs · acting voices",
  openai: "OpenAI · acting voices",
  builtin: "On-device AI voice",
  native: "Phone AI voice",
  browser: "Device voice · basic",
};

/** Used when the server can't be reached: the app still opens and plays what is saved. */
const OFFLINE_CONFIG: AppConfig = {
  providers: { studio: true, elevenlabs: false, openai: false, anthropic: false },
  studioMonthlyHours: 3,
  passwordRequired: false,
  authorized: true,
  mode: "open",
  plan: "premium",
  user: null,
  supabase: null,
  billing: false,
  voices: { openai: [], elevenlabs: [] },
};

const PROVIDER_BLURB: Record<Provider, string> = {
  studio: "The best voice, made on the voice server. Needs internet; saved passages play offline.",
  elevenlabs: "Lifelike acting voices with emotions (needs a voice key).",
  openai: "Expressive voices (needs a voice key).",
  builtin: "Made in the browser on this device, after one download. Works offline.",
  native: "Made by this phone's processor, after one download. Works offline, no limits.",
  browser: "The device's own voices. Instant, works everywhere, sounds plainer.",
};

const HOME_PAGES = [
  { icon: "📚", label: "Library" },
  { icon: "＋", label: "Add" },
  { icon: "🎙", label: "Voice" },
  { icon: "⚙", label: "Settings" },
];

const MUSIC_LABEL = { off: "Off", moments: "At key moments", always: "All the time" } as const;

const GENRE_LABEL: Record<string, string> = {
  novel: "Story / novel",
  children_story: "Children's story",
  guide: "Guide / how-to",
  textbook: "Textbook",
  news: "News / article",
  poetry: "Poetry",
  play: "Play / script",
  essay: "Essay",
  other: "General text",
};

const EMOTION_ICON: Record<string, string> = {
  happy: "😊", sad: "😢", angry: "😠", fearful: "😨", excited: "🤩", whisper: "🤫",
  tender: "🥰", sarcastic: "😏", surprised: "😮", serious: "😐", calm: "😌",
  curious: "🤔", mysterious: "🌫️",
};

const AMBIENCE_ICON: Record<string, string> = {
  rain: "🌧️", storm: "⛈️", wind: "🌬️", sea: "🌊", fire: "🔥", forest: "🌲", night: "🌙", city: "🏙️", cave: "🕳️",
};

const SPEEDS = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

const SAMPLE = `The Lighthouse Keeper

Chapter 1 — The Storm

The storm had been building since noon, and by the time Elena reached the lighthouse, the sea was throwing itself against the rocks. Thunder cracked somewhere over the water.

Old Tomas was waiting at the door, lantern in hand. "You came," he said quietly. "I didn't think anyone would come tonight."

"Of course I came!" Elena laughed, shaking the rain from her coat. "You think a little wind would stop me?"

He didn't smile. "It's not the wind I'm worried about," he whispered. "Something is out there, Elena. I saw it again."

Chapter 2 — The Light

She stopped laughing. Far out on the black water, a light blinked once, twice — and then went dark.

"Tomas," she said slowly, "ships don't signal like that."

"No," the old man answered, his voice trembling. "They don't."`;

const speakerColor = (name: string) => (name === "Narrator" ? "var(--ink-dim)" : `hsl(${hash(name) % 360} 65% 68%)`);

const timeAgo = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

export default function Home() {
  const engineRef = useRef<ReaderEngine | null>(null);
  const sbRef = useRef<SupabaseClient | null>(null);
  const [, setTick] = useState(0);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [panel, setPanel] = useState<"none" | "cast" | "sound">("none");
  const [sidebar, setSidebar] = useState(false);
  /** The voice chooser opened by touching the voice that is speaking. */
  const [voiceSheet, setVoiceSheet] = useState<string | null>(null);
  const [modal, setModal] = useState<"none" | "account" | "signin">("none");
  const [email, setEmail] = useState("");
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [homePage, setHomePage] = useState(0);
  const goPage = (n: number) => {
    const el = pagesRef.current;
    if (el) el.scrollTo({ left: n * el.clientWidth, behavior: "smooth" });
    setHomePage(n);
  };
  const onPagesScroll = () => {
    const el = pagesRef.current;
    if (el) setHomePage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
  };
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refreshBooks = useCallback(() => library.list().then(setBooks), []);
  const [serverWait, setServerWait] = useState<string | null>(null);

  const loadConfig = useCallback(async (e: ReaderEngine) => {
    // The voice server may be this site's own, or a separate one (Hugging Face / Vercel).
    const found = await findServer<AppConfig>(e.headers(), (msg) => setServerWait(msg));
    setServerWait(null);
    const c: AppConfig = found?.config ?? OFFLINE_CONFIG; // no connection (or no server): open anyway
    setCfg(c);
    e.setConfig(c);
    return c;
  }, []);

  // Installable app + offline: register the service worker, catch Chrome's install prompt.
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<unknown> } | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
    if ("serviceWorker" in navigator && location.hostname !== "localhost") navigator.serviceWorker.register(asset("/sw.js"), { scope: asset("/") || "/" }).catch(() => {});
    const onPrompt = (ev: Event) => {
      ev.preventDefault();
      setInstallEvt(ev as unknown as { prompt: () => Promise<unknown> });
    };
    const onInstalled = () => { setInstalled(true); setInstallEvt(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  const playingNow = engineRef.current?.playing ?? false;
  const titleNow = engineRef.current?.title ?? "";
  const chapterNow = engineRef.current ? engineRef.current.chapters[engineRef.current.currentChapterIndex()]?.title ?? "" : "";
  const percentNow = engineRef.current?.chunks.length ? Math.round(engineRef.current.progress() * 100) : -1;
  useEffect(() => {
    const e = engineRef.current;
    if (!e || (!titleNow && !playingNow)) return;
    // The lock screen / notification player: book, chapter, play state, progress.
    e.native.setPlaying(playingNow, titleNow || "Voicebook", chapterNow, percentNow >= 0 ? percentNow / 100 : -1);
  }, [playingNow, titleNow, chapterNow, percentNow]);

  useEffect(() => {
    const e = new ReaderEngine(() => setTick((t) => t + 1));
    engineRef.current = e;
    // Books found on the phone: a chosen folder shows everything; the quiet check at start shows only new ones.
    e.native.onScan = (r) => {
      if (!r.auto) return setScan(r);
      const done = importedSet();
      const fresh = r.files.filter((f) => !done.has(importedKey(f.name, f.size)));
      if (fresh.length) setScan({ ...r, files: fresh });
    };
    setTimeout(() => e.native.rescan(), 2500);
    setTimeout(() => void e.native.checkUpdate(), 4000);
    (window as unknown as { __voicebook?: ReaderEngine }).__voicebook = e; // handy when troubleshooting
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        const c = await loadConfig(e);
        if (c.supabase) {
          const sb = getSupabase(c.supabase.url, c.supabase.anonKey);
          sbRef.current = sb;
          const { data } = await sb.auth.getSession();
          e.accessToken = data.session?.access_token ?? "";
          await loadConfig(e);
          const { data: sub } = sb.auth.onAuthStateChange((_ev, session) => {
            const token = session?.access_token ?? "";
            if (token !== e.accessToken) {
              e.accessToken = token;
              loadConfig(e);
            }
          });
          unsub = () => sub.subscription.unsubscribe();
        }
        if (new URLSearchParams(location.search).has("upgraded")) {
          history.replaceState(null, "", "/");
          setTimeout(() => loadConfig(e), 2500); // give the Stripe webhook a moment
        }
      } catch {
        /* sign-in is unavailable right now; the reader still works */
      }
    })();
    refreshBooks();
    return () => {
      unsub?.();
      e.destroy();
    };
  }, [loadConfig, refreshBooks]);

  const e = engineRef.current;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [e?.index, e?.segments.length === 0]);

  // While audio is being prepared, refresh once a second so the wait is visibly counted.
  const waiting = !!e?.buffering;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  const openBook = async (title: string, sections: { title: string; text: string }[], author?: string) => {
    if (!e) return;
    const { chunks, chapters } = buildBook(sections);
    if (!chunks.length) {
      setLoadError("No readable text found.");
      return;
    }
    const id = bookId(title, chunks.join("\n"));
    const existing = await library.get(id);
    const record: BookRecord = existing ?? {
      id,
      title,
      chunks,
      chapters,
      author,
      shelf: shelfFor(chunks),
      addedAt: Date.now(),
      openedAt: Date.now() + 2000, // opened right away: not "new"
      position: { chunk: 0, offset: 0 },
    };
    if (!existing) await library.put(record);
    await e.open(record);
    refreshBooks();
  };

  const resumeBook = async (id: string) => {
    const rec = await library.get(id);
    if (rec && e) await e.open(rec);
  };

  const [importNote, setImportNote] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);

  /** Add books to the library without opening them (several at once). */
  const importFiles = async (files: File[], source?: string, folders?: (string | undefined)[]) => {
    setLoadError(null);
    let added = 0;
    let known = 0;
    const failed: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setBusy(`Adding books… ${i + 1} of ${files.length}: ${f.name}`);
      try {
        const book = await extractText(f);
        const { chunks, chapters } = buildBook(book.sections);
        if (!chunks.length) throw new Error("no text");
        const id = bookId(book.title, chunks.join("\n"));
        const existing = await library.get(id);
        if (existing) {
          known++;
          // Added before: just remember where it lives now (folder view).
          if (folders?.[i] && existing.folder !== folders[i]) await library.patch(id, { folder: folders[i], fileName: f.name });
        } else {
          const now = Date.now();
          await library.put({
            id, title: book.title, author: book.author, chunks, chapters, addedAt: now, openedAt: now,
            position: { chunk: 0, offset: 0 }, shelf: shelfFor(chunks), source, folder: folders?.[i], fileName: f.name,
          });
          added++;
        }
        rememberImported(f);
      } catch {
        failed.push(f.name);
      }
    }
    setBusy(null);
    refreshBooks();
    setImportNote(
      [
        added ? `Added ${added} book${added > 1 ? "s" : ""} to your library.` : "",
        known ? `${known} ${known > 1 ? "were" : "was"} already there.` : "",
        failed.length ? `Couldn't read: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""} (scanned images or protected files).` : "",
      ].filter(Boolean).join(" "),
    );
  };

  const onFiles = (list: FileList | File[]) => {
    const files = [...list];
    if (files.length === 1) return onFile(files[0]);
    if (files.length > 1) return importFiles(files);
  };

  const onFile = async (file: File) => {
    setLoadError(null);
    setBusy("Reading file…");
    try {
      const book = await extractText(file, (p) => setBusy(`Reading PDF… ${Math.round(p * 100)}%`));
      await openBook(book.title, book.sections, book.author);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not read this file.");
    } finally {
      setBusy(null);
    }
  };

  const goHome = () => {
    e?.close();
    setSidebar(false);
    setPanel("none");
    refreshBooks();
  };

  const startCheckout = async () => {
    if (!e) return;
    if (!cfg?.user) return setModal("signin");
    const r = await fetch(api("/api/checkout"), { method: "POST", headers: e.headers() });
    const d = await r.json();
    if (d.url) location.href = d.url;
    else setAuthMsg(d.error ?? "Could not start checkout");
  };

  const openPortal = async () => {
    if (!e) return;
    const r = await fetch(api("/api/portal"), { method: "POST", headers: e.headers() });
    const d = await r.json();
    if (d.url) location.href = d.url;
    else setAuthMsg(d.error ?? "Could not open billing");
  };

  const sendMagicLink = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const sb = sbRef.current;
    if (!sb) return;
    setAuthMsg("Sending…");
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
    setAuthMsg(error ? error.message : "Check your inbox — we sent you a sign-in link ✉️");
  };

  const signInWithGoogle = async () => {
    await sbRef.current?.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin } });
  };

  const signOut = async () => {
    await sbRef.current?.auth.signOut();
    if (e) {
      e.accessToken = "";
      e.close();
      await loadConfig(e);
    }
    setModal("none");
  };

  if (!e || !cfg) {
    return <main className="center">{loadError ?? <div className="spinner" />}</main>;
  }

  // ---------- password gate (personal mode) ----------
  if (cfg.mode === "open" && cfg.passwordRequired && !cfg.authorized) {
    return (
      <main className="center">
        <form
          className="card gate"
          onSubmit={async (ev) => {
            ev.preventDefault();
            e.setPassword(pw);
            await loadConfig(e);
          }}
        >
          <h1 className="logo">Voicebook</h1>
          <p className="muted">This reader is private. Enter the password.</p>
          <input type="password" value={pw} onChange={(x) => setPw(x.target.value)} placeholder="Password" autoFocus />
          <button className="btn primary">Enter</button>
        </form>
      </main>
    );
  }

  const signedOut = cfg.mode === "accounts" && !cfg.user;
  const hasBook = e.chunks.length > 0;
  const current = e.segments[e.index];
  const progress = hasBook ? e.progress() : 0;
  const voices = e.voicesFor();
  const deviceVoices = e.provider === "browser";
  const actingVoices = e.provider === "elevenlabs" || e.provider === "openai";
  /** Show who speaks (names, colours) only when characters have their own voices. */
  const cast = !e.oneVoice;
  const usage = e.studioUsage();
  const waitedFor = e.waitingSince ? Math.max(0, Math.round((Date.now() - e.waitingSince) / 1000)) : 0;
  const speakers = e.oneVoice ? ["Narrator"] : ["Narrator", ...e.characters.map((c) => c.name)];
  /** Characters found by the pre-scan (or the AI), not the "Speaker A/B" stand-ins. */
  const realCast = e.characters.filter((c) => !/^Speaker [AB]$/.test(c.name));
  const chapterIdx = e.currentChapterIndex();
  const premium = e.premium;
  const showUpgrade = e.premiumPrompt;
  const currentScene = current ? e.scenes.get(current.chunk) : undefined;

  const signInForm = (
    <form className="signin" onSubmit={sendMagicLink}>
      <input type="email" required value={email} onChange={(x) => setEmail(x.target.value)} placeholder="you@email.com" />
      <button className="btn primary">Email me a sign-in link</button>
      <button type="button" className="btn" onClick={signInWithGoogle}>Continue with Google</button>
      {authMsg && <p className="muted small">{authMsg}</p>}
    </form>
  );

  return (
    <main className={`app ${hasBook ? "reading" : ""}`}>
      <header className="top">
        <div className="row gap-s">
          {hasBook && (
            <button className="icon-btn" onClick={() => setSidebar((s) => !s)} aria-label="Chapters">☰</button>
          )}
          <button className="logo-btn" onClick={goHome} aria-label="Library">
            <span className="logo">Voicebook</span>
          </button>
        </div>
        <div className="row gap-s">
          {hasBook && !signedOut && (
            <button className="icon-btn" onClick={() => setPanel("cast")} aria-label="Voices">🎭</button>
          )}
          {cfg.mode === "accounts" && (
            <button className="avatar" onClick={() => setModal(cfg.user ? "account" : "signin")} aria-label="Account">
              {cfg.user ? cfg.user.email[0].toUpperCase() : "→"}
              {premium && <span className="crown">★</span>}
            </button>
          )}
        </div>
      </header>

      {/* ---------- Home: swipeable pages ---------- */}
      {!hasBook && signedOut && (
        <section className="hero">
          <h1>Any book, read to you <em>in a studio voice.</em></h1>
          <div className="card">
            <h3 className="card-title">Sign in to start listening</h3>
            {signInForm}
          </div>
        </section>
      )}
      {!hasBook && !signedOut && (
        <section className="home">
          <div className="pages" ref={pagesRef} onScroll={onPagesScroll}>
            {/* 1 · Library */}
            <div className="page">
              {serverWait && <p className="muted small notice">⏳ {serverWait}</p>}
              {importNote && <p className="muted small notice">{importNote}</p>}
              {loadError && <p className="error">{loadError}</p>}
              {books.length > 0 ? (
                <>
                  <LibraryView
                    books={books}
                    onOpen={resumeBook}
                    onRemove={async (b) => {
                      if (confirm(`Remove “${b.title}” from your library?`)) {
                        await library.remove(b.id);
                        refreshBooks();
                      }
                    }}
                  />
                </>
              ) : (
                <div className="empty">
                  <h1>Any book, read to you <em>in a studio voice.</em></h1>
                  <p className="muted">
                    Add a PDF, EPUB or text and press play. Voicebook finds the chapters and the characters, remembers where you
                    stopped, and keeps the audio on your device.
                  </p>
                  <button className="btn primary" onClick={() => goPage(1)}>＋ Add your first book</button>
                  <button className="btn" onClick={() => openBook("The Lighthouse Keeper", detectSections(SAMPLE))}>Try a sample story</button>
                </div>
              )}
            </div>

            {/* 2 · Add books */}
            <div className="page">
              <h2 className="page-title">Add books</h2>
              <button className="dropzone" onClick={() => fileRef.current?.click()} disabled={!!busy}
                onDragOver={(x) => x.preventDefault()}
                onDrop={(x) => { x.preventDefault(); if (x.dataTransfer.files.length) onFiles(x.dataTransfer.files); }}>
                {busy ? <><div className="spinner" /> {busy}</> : <>
                  <span className="drop-icon">📖</span>
                  <strong>Choose files</strong>
                  <span className="muted small">PDF · EPUB · TXT · several at once · from the phone, Drive or iCloud</span>
                </>}
              </button>
              <input ref={fileRef} type="file" hidden accept=".pdf,.epub,.txt,.md,.markdown,.html,.htm,application/pdf,text/plain"
                multiple
                onChange={(x) => { if (x.target.files?.length) onFiles(x.target.files); x.target.value = ""; }} />
              <div className="tiles">
                {e?.native.available && e.native.canScan && (
                  <>
                    <button className="tile" disabled={!!busy} onClick={() => e.native.scanPhone()}>
                      <span>📱</span><strong>Find books on this phone</strong><small className="muted">Looks through your folders</small>
                    </button>
                    {e.native.canScanPhone && (
                      <button className="tile" disabled={!!busy} onClick={() => e.native.scanFolder()}>
                        <span>📁</span><strong>Choose a folder</strong><small className="muted">Keeps its subfolders</small>
                      </button>
                    )}
                  </>
                )}
                <button className="tile" onClick={() => setShowPaste((x) => !x)}>
                  <span>📋</span><strong>Paste text</strong><small className="muted">An article, a chapter…</small>
                </button>
                <button className="tile" onClick={() => setSharingOpen(true)}>
                  <span>⇄</span><strong>From another device</strong><small className="muted">Send books between your phones</small>
                </button>
                <button className="tile" onClick={() => openBook("The Lighthouse Keeper", detectSections(SAMPLE))}>
                  <span>✨</span><strong>Sample story</strong><small className="muted">Hear what it can do</small>
                </button>
              </div>
              {showPaste && (
                <div className="paste">
                  <textarea value={paste} onChange={(x) => setPaste(x.target.value)} placeholder="Paste any text here…" rows={8} />
                  <button className="btn primary" disabled={!paste.trim()}
                    onClick={() => openBook(paste.trim().split("\n")[0].slice(0, 50) || "Pasted text", detectSections(paste))}>Read it</button>
                </div>
              )}
            </div>

            {/* 3 · Voice */}
            <div className="page">
              <h2 className="page-title">Voice</h2>
              <div className="provider-cards" role="radiogroup" aria-label="Kind of voice">
                {e.availableProviders().map((pv) => (
                  <button key={pv} role="radio" aria-checked={e.provider === pv} className={`provider-card${e.provider === pv ? " chosen" : ""}`} onClick={() => e.setProvider(pv)}>
                    <strong>{PROVIDER_LABEL[pv]}</strong>
                    <small className="muted">{PROVIDER_BLURB[pv]}</small>
                  </button>
                ))}
                {e.lockedProviders().map((pv) => (
                  <button key={pv} className="provider-card locked" onClick={() => e.setProvider(pv)}>
                    <strong>🔒 {PROVIDER_LABEL[pv]}</strong>
                    <small className="muted">{PROVIDER_BLURB[pv]}</small>
                  </button>
                ))}
              </div>
              {inAndroidApp() && !e.native.ready && (
                <div className="install-card small">
                  <p>
                    <strong>📱 Voice for offline listening</strong>
                    <br />
                    <span className="muted">With this download, the phone makes the voice itself when there&apos;s no connection.</span>
                  </p>
                  {e.native.downloading ? (
                    <p className="muted">Downloading… {Math.round(e.native.progress * 100)}% (keep the app open)</p>
                  ) : (
                    <button className="btn primary" onClick={() => { e.native.download(); e.setProvider("native"); }}>
                      Download ({e.native.status()?.mb ?? "?"} MB, {e.native.tier === "best" ? "best quality" : e.native.tier === "light" ? "light and quick" : "fast"})
                    </button>
                  )}
                </div>
              )}
              {e.provider === "native" && <NativePanel e={e} />}
              {e.provider === "builtin" && <OnDevicePanel e={e} />}
              <CursorSettings e={e} />
              <div className="status-list small">
                <span className={cfg.providers.studio ? "ok" : "off"}>Studio voice server</span>
                <span className={cfg.providers.anthropic ? "ok" : "off"}>Characters &amp; emotions (AI key)</span>
                <span className={cfg.providers.elevenlabs || cfg.providers.openai ? "ok" : "off"}>Acting voices (voice key)</span>
              </div>
            </div>

            {/* 4 · Settings */}
            <div className="page">
              <h2 className="page-title">Settings</h2>
              {inAndroidApp() && e.native.update && (
                <div className="install-card small">
                  <p>
                    <strong>⬆ Voicebook {e.native.update.versionName} is ready</strong>
                    <br />
                    <span className="muted">An update of the app itself. Your books, voices and places are kept.</span>
                  </p>
                  {e.native.updateError && <p className="error">{e.native.updateError}</p>}
                  {e.native.updateProgress !== null ? (
                    <p className="muted">
                      {e.native.updateProgress < 1 ? `Downloading the update… ${Math.round(e.native.updateProgress * 100)}%` : "Tap “Update” on Android's screen to finish."}
                    </p>
                  ) : (
                    <button className="btn primary" onClick={() => e.native.installUpdate()}>Update now</button>
                  )}
                </div>
              )}
              <div className="settings-list">
                <button className="setting" onClick={() => setStorageOpen(true)}>
                  <span>🧹</span><span><strong>Storage &amp; speed</strong><small className="muted">Free space, clean up, keep reading in the background</small></span><span aria-hidden>›</span>
                </button>
                <button className="setting" onClick={() => setSharingOpen(true)}>
                  <span>⇄</span><span><strong>Share with another device</strong><small className="muted">Send or receive books with a 6-digit code</small></span><span aria-hidden>›</span>
                </button>
                {cfg.mode === "accounts" && (
                  <button className="setting" onClick={() => setModal(cfg.user ? "account" : "signin")}>
                    <span>👤</span><span><strong>{cfg.user ? "Your account" : "Sign in"}</strong><small className="muted">{cfg.user ? cfg.user.email : "Keep your plan on every device"}</small></span><span aria-hidden>›</span>
                  </button>
                )}
                {!premium && cfg.mode === "accounts" && (
                  <button className="setting" onClick={() => (e.premiumPrompt = true, setTick((t) => t + 1))}>
                    <span>★</span><span><strong>Premium</strong><small className="muted">Acting voices, accents, ambience and music</small></span><span aria-hidden>›</span>
                  </button>
                )}
              </div>
              {!inAndroidApp() && (!installed || isAndroid()) && <InstallCard evt={installEvt} installed={installed} />}
              <p className="muted small credits">
                Studio voice: Kokoro (Apache 2.0). Light phone voice: Piper, LibriTTS-R (MIT, CC BY 4.0). Sound effects made in the app.
              </p>
            </div>
          </div>
          <nav className="tabbar" aria-label="Pages">
            {HOME_PAGES.map((pg, n) => (
              <button key={pg.label} className={homePage === n ? "on" : ""} onClick={() => goPage(n)} aria-current={homePage === n ? "page" : undefined}>
                <span aria-hidden>{pg.icon}</span>
                <small>{pg.label}</small>
              </button>
            ))}
          </nav>
        </section>
      )}

      {/* ---------- Reader ---------- */}
      {hasBook && (
        <div className="layout">
          <aside className={`sidebar ${sidebar ? "open" : ""}`}>
            <div className="sidebar-head">
              <strong className="small">Contents</strong>
              <button className="icon-btn subtle mobile-only" onClick={() => setSidebar(false)} aria-label="Close">✕</button>
            </div>
            <nav>
              {e.chapters.map((ch, i) => (
                <button
                  key={`${ch.chunk}-${i}`}
                  className={`chapter ${i === chapterIdx ? "current" : ""} ${i < chapterIdx ? "done" : ""}`}
                  onClick={() => { e.jumpToChunk(ch.chunk); setSidebar(false); }}
                >
                  <span className="ch-num">{i < chapterIdx ? "✓" : i + 1}</span>
                  <span className="ch-title">{ch.title}</span>
                </button>
              ))}
            </nav>
          </aside>
          {sidebar && <div className="scrim mobile-only" onClick={() => setSidebar(false)} />}

          <div className="content">
            <section className="book-head">
              <p className="muted small chapter-label">{e.chapters[chapterIdx]?.title}</p>
              <h2>{e.title}</h2>
              <div className="chips">
                {e.meta.genre && <span className="chip">{GENRE_LABEL[e.meta.genre] ?? e.meta.genre}</span>}
                {e.meta.language && <span className="chip">{e.meta.language.toUpperCase()}</span>}
                {premium && currentScene && currentScene.ambience !== "none" && e.prefs.ambience && (
                  <span className="chip">{AMBIENCE_ICON[currentScene.ambience]} {currentScene.ambience}</span>
                )}
                <button className={`chip link ${panel === "cast" ? "on" : ""}`} onClick={() => setPanel((p) => (p === "cast" ? "none" : "cast"))}>
                  🎭 {realCast.length ? `${realCast.length} character${realCast.length > 1 ? "s" : ""}` : e.oneVoice ? "Voice" : `Voices (${e.characters.length + 1})`}
                </button>
                <button className={`chip link ${panel === "sound" ? "on" : ""}`} onClick={() => setPanel((p) => (p === "sound" ? "none" : "sound"))}>
                  🎵 Sound {premium ? "" : "🔒"}
                </button>
              </div>
              {e.meta.narrationStyle && <p className="muted small style">🎙️ {e.meta.narrationStyle}</p>}
            </section>

            {panel !== "none" && (
              <div className="modal-bg sheet-bg" onClick={() => setPanel("none")}>
                <div className="card modal reader-sheet" onClick={(x) => x.stopPropagation()} role="dialog" aria-label="Voices and sound">
                  <div className="row between sheet-head">
                    <div className="seg-toggle" role="tablist">
                      <button role="tab" aria-selected={panel === "cast"} className={panel === "cast" ? "on" : ""} onClick={() => setPanel("cast")}>🎭 Voices</button>
                      <button role="tab" aria-selected={panel === "sound"} className={panel === "sound" ? "on" : ""} onClick={() => setPanel("sound")}>🎵 Sound</button>
                    </div>
                    <button className="icon small-icon" onClick={() => setPanel("none")} aria-label="Close">✕</button>
                  </div>
            {panel === "cast" && (
              <section className="cast">
                <label className="field-inline small">
                  <span className="muted">Kind of voice</span>
                  <select value={e.provider} onChange={(x) => e.setProvider(x.target.value as Provider)}>
                    {e.availableProviders().map((pv) => <option key={pv} value={pv}>{PROVIDER_LABEL[pv]}</option>)}
                    {e.lockedProviders().map((pv) => <option key={pv} value={pv}>🔒 {PROVIDER_LABEL[pv]}</option>)}
                  </select>
                </label>
                <CursorSettings e={e} />
                {e.provider === "studio" && (
                  <div className="studio-info small">
                    <p>
                      <strong>Studio voice.</strong> Each passage is generated once on the server, then saved on this device,
                      so replaying it is instant and works without a connection. It reads English.
                    </p>
                    {usage.limited && (
                      <>
                        <div className="meter" role="img" aria-label={`${Math.round(usage.fraction * 100)}% of this month's allowance used`}>
                          <span style={{ width: `${Math.max(2, usage.fraction * 100)}%` }} />
                        </div>
                        <p className="muted">
                          {usage.audioMinutes} min of new audio made this month on this device ({Math.round(usage.fraction * 100)}% of the
                          free monthly allowance).
                        </p>
                      </>
                    )}
                    {e.savedPassages > 0 && (
                      <p className="muted">
                        {e.savedPassages} passages of this book are saved on this device.{" "}
                        <button
                          className="link-btn"
                          onClick={() => confirm("Delete this book's saved audio from this device? It will be generated again when you listen.") && e.clearSavedAudio()}
                        >
                          Delete saved audio
                        </button>
                      </p>
                    )}
                  </div>
                )}
                {e.provider === "builtin" && <OnDevicePanel e={e} />}
                {e.provider === "native" && <NativePanel e={e} />}
                <label className="toggle">
                  <input type="checkbox" checked={e.prefs.singleVoice} onChange={(x) => e.setPrefs({ singleVoice: x.target.checked })} /> One voice reads everything
                  <span className="muted small">The most natural. Turn off to give each character their own voice.</span>
                </label>
                {voices.length === 0 && <p className="muted small">No voices available for this engine on this device.</p>}
                {e.provider === "browser" && voices.length > 0 && !voices.some((v) => v.name.startsWith("★")) && (
                  <p className="tip small">
                    💡 This device only has its basic voices, which sound flat. The natural ones are a free download:
                    <br />• <strong>iPhone/iPad:</strong> Settings → Accessibility → Spoken Content → Voices → English → choose <strong>Ava</strong>, <strong>Zoe</strong> or <strong>Evan</strong> → download the <em>Premium</em> version (or <em>Enhanced</em>).
                    <br />• <strong>Android:</strong> Settings → Text-to-speech → Google → install the English voice data.
                    <br />• <strong>Computer:</strong> open the app in Microsoft Edge, whose “Natural” voices are the best free ones.
                    <br />Then close and reopen the app. Once a ★ voice is installed, only ★ voices are listed here.
                  </p>
                )}
                {deviceVoices && voices.length > 0 && (
                  <div className="device-opts">
                    <label className="slider">Emotion strength <span className="muted small">{["flat", "gentle", "normal", "strong", "dramatic"][Math.round(e.prefs.expressiveness * 2)]}</span>
                      <input type="range" min={0} max={2} step={0.5} value={e.prefs.expressiveness} onChange={(x) => e.setPrefs({ expressiveness: Number(x.target.value) })} />
                    </label>
                    <label className="slider">Pauses between lines <span className="muted small">{["none", "short", "normal", "long", "very long"][Math.round(e.prefs.pauses * 2)]}</span>
                      <input type="range" min={0} max={2} step={0.5} value={e.prefs.pauses} onChange={(x) => e.setPrefs({ pauses: Number(x.target.value) })} />
                    </label>
                    {!e.prefs.singleVoice && <label className="toggle">
                      <input type="checkbox" checked={e.prefs.characterPitch} onChange={(x) => e.setPrefs({ characterPitch: x.target.checked })} /> Different pitch per character
                      <span className="muted small">Lower for men, higher for women and children. Turn off if voices sound unnatural.</span>
                    </label>}
                  </div>
                )}
                {e.casting_ai && <p className="tip small">✨ The AI is reading the book to cast its characters…</p>}
                {e.oneVoice && realCast.length > 0 && (
                  <div className="cast-found small">
                    <p>
                      <strong>Characters in this book</strong> <span className="muted">· found before reading, most talkative first</span>
                    </p>
                    <div className="cast-chips">
                      {realCast.slice(0, 16).map((c) => (
                        <span key={c.name} className="cast-chip" style={{ ["--c" as string]: speakerColor(c.name) }}>
                          {c.age === "child" ? "🧒" : c.age === "elderly" ? (c.gender === "female" ? "👵" : "👴") : c.gender === "female" ? "👩" : c.gender === "male" ? "👨" : "🙂"} {c.name}
                          {c.lines ? <small className="muted"> {c.lines}</small> : null}
                        </span>
                      ))}
                    </div>
                    <button className="btn small-btn" onClick={() => e.setPrefs({ singleVoice: false })}>Give each character their own voice</button>
                  </div>
                )}
                {speakers.map((name) => {
                  const ch = e.character(name);
                  return (
                    <div key={name} className="cast-row">
                      <span className="dot" style={{ background: speakerColor(name) }} />
                      <span className="cast-name">
                        {e.oneVoice ? "Reading voice" : name}
                        {ch && <small className="muted"> {ch.gender !== "neutral" ? ch.gender : ""} {ch.age !== "adult" ? ch.age : ""} {ch.traits ? `· ${ch.traits}` : ""}</small>}
                        {ch?.aliases?.length ? <small className="muted aliases"> also “{ch.aliases.slice(0, 3).join("”, “")}”</small> : null}
                      </span>
                      <div className="cast-selects">
                        <button
                          className="preview-btn"
                          onClick={() => e.preview(name)}
                          disabled={!!e.previewing}
                          aria-label={`Preview ${name}'s voice`}
                        >
                          {e.previewing === name ? <span className="spinner inline" /> : "▶"}
                        </button>
                        <select
                          className={actingVoices ? "" : "span2"}
                          value={e.casting[name] ?? ""}
                          onChange={(x) => e.setVoice(name, x.target.value)}
                          aria-label={`Voice for ${name}`}
                        >
                          {[voices.filter((v) => !v.more), voices.filter((v) => v.more)].map((group, gi) =>
                            group.length === 0 ? null : (
                              <optgroup key={gi} label={gi ? "More voices" : "Best voices"}>
                                {group.map((v) => (
                                  <option key={v.id} value={v.id}>{v.name}{v.gender !== "neutral" ? ` (${v.gender[0].toUpperCase()})` : ""}</option>
                                ))}
                              </optgroup>
                            ),
                          )}
                        </select>
                        {actingVoices && (
                          <select value={e.accents[name] ?? ""} onChange={(x) => e.setAccent(name, x.target.value)} aria-label={`Accent for ${name}`}>
                            {ACCENTS.map((a) => <option key={a} value={a}>{a ? `${premium ? "" : "🔒 "}${a} accent` : "Default accent"}</option>)}
                          </select>
                        )}
                        {deviceVoices && (
                          <div className="tweaks">
                            <label>Pitch
                              <input type="range" min={0.6} max={1.5} step={0.05} value={e.tweaks[name]?.pitch ?? 1}
                                onChange={(x) => e.setTweak(name, { pitch: Number(x.target.value) })} aria-label={`Pitch for ${name}`} />
                            </label>
                            <label>Speed
                              <input type="range" min={0.7} max={1.4} step={0.05} value={e.tweaks[name]?.speed ?? 1}
                                onChange={(x) => e.setTweak(name, { speed: Number(x.target.value) })} aria-label={`Speed for ${name}`} />
                            </label>
                            {(e.tweaks[name]?.pitch ?? 1) !== 1 || (e.tweaks[name]?.speed ?? 1) !== 1 ? (
                              <button className="link-btn" onClick={() => e.setTweak(name, { pitch: 1, speed: 1 })}>Reset</button>
                            ) : null}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            {panel === "sound" && (
              <section className="sound">
                {!premium ? (
                  <div className="locked">
                    <p>🔒 Ambience, background music and sound effects are part of <strong>Premium</strong>.</p>
                    <button className="btn primary" onClick={() => (e.premiumPrompt = true, setTick((t) => t + 1))}>See Premium</button>
                  </div>
                ) : (
                  <>
                    <label className="choice">
                      <span>Background music</span>
                      <select value={e.prefs.music} onChange={(x) => e.setPrefs({ music: x.target.value as keyof typeof MUSIC_LABEL })} aria-label="Background music">
                        {(Object.keys(MUSIC_LABEL) as (keyof typeof MUSIC_LABEL)[]).map((m) => <option key={m} value={m}>{MUSIC_LABEL[m]}</option>)}
                      </select>
                      <span className="muted small">
                        {e.prefs.music === "moments"
                          ? "Comes in when a chapter opens, the mood changes or a line is intense, then fades away."
                          : e.prefs.music === "always"
                            ? "Plays under the whole story, following the mood."
                            : "No music."}
                      </span>
                    </label>
                    <label className="toggle"><input type="checkbox" checked={e.prefs.ambience} onChange={(x) => e.setPrefs({ ambience: x.target.checked })} /> Scene sounds <span className="muted small">rain, sea, fire, forest… set the scene, then settle into the background</span></label>
                    {cfg.providers.elevenlabs && (
                      <label className="toggle">
                        <input type="checkbox" checked={e.prefs.sfx} onChange={(x) => e.setPrefs({ sfx: x.target.checked })} /> Sound effects
                        <span className="muted small">thunder, doors, footsteps… when the story calls for them</span>
                      </label>
                    )}
                    <label className="slider">Background volume
                      <input type="range" min={0} max={1} step={0.05} value={e.prefs.bgVolume} onChange={(x) => e.setPrefs({ bgVolume: Number(x.target.value) })} />
                    </label>
                  </>
                )}
              </section>
            )}
                </div>
              </div>
            )}

            <article className="reader">
              {e.segments.length === 0 && (
                <p className="muted center-text"><span className="spinner inline" /> Opening this part of the book…</p>
              )}
              {e.segments.map((s, i) => {
                const prev = e.segments[i - 1];
                const firstOfPart = i === 0 || prev.chunk !== s.chunk;
                const chapterStart = firstOfPart ? e.chapters.find((c) => c.chunk === s.chunk) : undefined;
                // Show the chapter name unless the text itself opens with it.
                const named = chapterStart?.title.split(" — ")[0] ?? "";
                const newPart = chapterStart && !e.segments.slice(i, i + 3).some((x) => x.chunk === s.chunk && x.text.startsWith(named));
                const heading = e.isHeading(s);
                const active = i >= e.index && i <= e.groupEnd;
                if (s.fx)
                  return (
                    <span key={s.id}>
                      {s.para && !firstOfPart && <span className="para-break" aria-hidden />}
                      <span
                        ref={i === e.index ? activeRef : undefined}
                        className={`seg fx ${active ? "active" : ""}`}
                        onClick={() => e.jump(i)}
                        title={s.fx === "chime" ? "Game message" : `Sound effect · ${s.fx}`}
                      >
                        {s.fx === "chime" ? "🔔" : `🔊 ${s.text}`}
                      </span>{" "}
                    </span>
                  );
                return (
                  <span key={s.id}>
                    {newPart && <span className="part-break" aria-hidden>{chapterStart.title}</span>}
                    {s.para && !firstOfPart && !heading && <span className="para-break" aria-hidden />}
                    <span
                      ref={i === e.index ? activeRef : undefined}
                      className={`seg ${active ? "active" : ""} ${heading ? "heading" : ""} ${cast && s.speaker !== "Narrator" ? "dialogue" : ""} ${s.speaker === "System" ? "system" : ""}`}
                      style={cast && s.speaker !== "Narrator" ? { ["--c" as string]: speakerColor(s.speaker) } : undefined}
                      onClick={() => (active && e.playing ? setVoiceSheet(s.speaker) : e.jump(i))}
                      title={cast ? `${s.speaker} · ${s.emotion}${s.delivery ? ` · ${s.delivery}` : ""}${s.sfx ? ` · 🔊 ${s.sfx}` : ""}` : undefined}
                    >
                      {cast && s.speaker !== "Narrator" && <span className="who">{s.speaker}{EMOTION_ICON[s.emotion] ? ` ${EMOTION_ICON[s.emotion]}` : ""}</span>}
                      {s.sfx && premium && e.prefs.sfx && cfg.providers.elevenlabs && <span className="sfx">🔊</span>}
                      {active && e.playing && e.prefs.cursor === "word" ? (
                        <LiveText e={e} i={i} text={s.text} open={!cast && (s.quote ?? 0) & 1 ? "“" : ""} close={!cast && (s.quote ?? 0) & 2 ? "”" : ""} />
                      ) : !cast && s.quote ? `${s.quote & 1 ? "“" : ""}${s.text}${s.quote & 2 ? "”" : ""}` : s.text}
                    </span>{" "}
                  </span>
                );
              })}
              {e.analyzing && e.segments.length > 0 && <p className="muted small center-text">Preparing the next part…</p>}
            </article>
          </div>

          <footer className="player">
            <div className="bar" onClick={(x) => {
              const r = (x.currentTarget as HTMLElement).getBoundingClientRect();
              const c = Math.floor(((x.clientX - r.left) / r.width) * e.chunks.length);
              e.jumpToChunk(Math.max(0, Math.min(e.chunks.length - 1, c)));
            }}><div style={{ width: `${progress * 100}%` }} /></div>
            {e.notice && <p className="muted small notice">{e.notice}</p>}
            {e.error && (
              <p className="error small">
                {e.error}
              </p>
            )}
            <div className="now muted small">
              {e.waitMessage ? (
                <span className="dl">
                  {e.waitMessage} <strong>{e.waitPercent ?? 0}%</strong>
                  <span className="wait-bar" aria-hidden><span style={{ width: `${e.waitPercent ?? 0}%` }} /></span>
                </span>
              ) : current ? (
                <>
                  <button className="voice-chip" onClick={() => setVoiceSheet(current.speaker)} aria-label="Change the voice">
                    🎙 {voiceLabel(e, e.oneVoice ? "Narrator" : current.speaker)} ▾
                  </button>
                  <span className="sep">·</span>
                  <button className="link-btn" onClick={() => setSidebar(true)}>{e.chapters[chapterIdx]?.title ?? `part ${current.chunk + 1}`}</button>
                  <span className="sep">·</span>{Math.round(progress * 100)}%
                  {e.provider !== "browser" && e.playing && (
                    <span className="ahead" title="Passages already prepared">
                      <span className="sep">·</span>⚡{e.readyAhead} ready
                    </span>
                  )}
                </>
              ) : "Getting ready…"}
            </div>
            <div className="controls">
              <select className="speed" value={e.rate} onChange={(x) => e.setRate(Number(x.target.value))} aria-label="Speed">
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
              <button className="icon" onClick={() => e.previous()} aria-label="Previous">⏮</button>
              <button className="play" onClick={() => e.toggle()} disabled={e.segments.length === 0} aria-label={e.playing ? "Pause" : "Play"}>
                {e.buffering ? <span className="spinner" /> : e.playing ? "❚❚" : "▶"}
              </button>
              <button className="icon" onClick={() => e.next()} aria-label="Next">⏭</button>
              <button className="icon small-icon" onClick={() => setPanel("cast")} aria-label="Voices and sound">🎭</button>
            </div>
          </footer>
        </div>
      )}

      {/* ---------- Modals ---------- */}
      {storageOpen && e && <StoragePanel e={e} books={books} onClose={() => setStorageOpen(false)} onChanged={refreshBooks} />}
      {sharingOpen && <ShareDialog books={books} onClose={() => setSharingOpen(false)} onReceived={refreshBooks} />}
      {scan && e && (
        <ScanDialog
          scan={scan}
          onClose={() => setScan(null)}
          onImport={async (files) => {
            setScan(null);
            const read: File[] = [];
            const where: string[] = [];
            for (const f of files) {
              setBusy(`Opening ${f.name}…`);
              try {
                read.push(await e.native.readFound(f));
                where.push(f.folder);
              } catch {}
            }
            await importFiles(read, "phone", where);
          }}
        />
      )}
      {voiceSheet && hasBook && <VoiceSheet e={e} speaker={voiceSheet} onClose={() => setVoiceSheet(null)} />}
      {showUpgrade && (
        <div className="modal-bg" onClick={() => (e.premiumPrompt = false, setTick((t) => t + 1))}>
          <div className="card modal premium" onClick={(x) => x.stopPropagation()}>
            <h3>★ Voicebook Premium</h3>
            <ul className="perks">
              <li>🎭 Lifelike AI actors — a different voice for every character</li>
              <li>😢 Real emotion &amp; intonation: whispers, laughs, shouts, tears</li>
              <li>🗣️ Accents for narrator and characters</li>
              <li>🌧️ Ambience that follows the scene · 🎵 mood music</li>
              <li>🔊 Sound effects when the story calls for them</li>
            </ul>
            {cfg.mode === "open" ? (
              <p className="muted small">Everything is unlocked. Acting voices with emotions need a voice key (ElevenLabs or OpenAI) on the server.</p>
            ) : cfg.billing ? (
              <button className="btn primary wide" onClick={startCheckout}>{cfg.user ? "Upgrade now" : "Sign in to upgrade"}</button>
            ) : (
              <p className="muted small">Payments aren&apos;t set up on this server yet.</p>
            )}
            {authMsg && <p className="muted small">{authMsg}</p>}
            <button className="btn wide" onClick={() => (e.premiumPrompt = false, setTick((t) => t + 1))}>Not now</button>
          </div>
        </div>
      )}

      {modal !== "none" && (
        <div className="modal-bg" onClick={() => setModal("none")}>
          <div className="card modal" onClick={(x) => x.stopPropagation()}>
            {modal === "signin" || !cfg.user ? (
              <>
                <h3>Sign in</h3>
                {signInForm}
              </>
            ) : (
              <>
                <h3>Your account</h3>
                <p className="muted">{cfg.user.email}</p>
                <p>Plan: <strong>{premium ? "★ Premium" : "Free"}</strong></p>
                <div className="stack">
                  {!premium && <button className="btn primary wide" onClick={() => { setModal("none"); e.premiumPrompt = true; setTick((t) => t + 1); }}>Upgrade to Premium</button>}
                  {premium && cfg.billing && <button className="btn wide" onClick={openPortal}>Manage subscription</button>}
                  <button className="btn wide" onClick={signOut}>Sign out</button>
                </div>
                {authMsg && <p className="muted small">{authMsg}</p>}
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

/** Pick the size ("power") of the on-device voice that this device can carry. */
function OnDevicePanel({ e }: { e: ReaderEngine }) {
  const b = e.builtin;
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!b.check && !checking) {
      setChecking(true);
      void b.runCheck().finally(() => setChecking(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const advice = b.advice;
  const pct = Math.round((b.progress ?? 0) * 100);
  return (
    <div className="studio-info small ondevice">
      <p>
        <strong>On-device AI voice.</strong> Made by your own device, so after one download it works anywhere, even offline, with no
        monthly limit. Pick the size your device can carry.
      </p>
      {b.notice && <p className="tip">{b.notice}</p>}
      <label className="field">
        <span>This device</span>
        <select value={b.device} onChange={(x) => e.setDeviceKind(x.target.value as DeviceKind)}>
          {DEVICE_KINDS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {checking ? "Checking this device…" : b.check ? <>Detected: {b.check.summary}.</> : null}{" "}
        <button className="link-btn" disabled={checking} onClick={() => { setChecking(true); void b.runCheck().finally(() => setChecking(false)); }}>
          Check again
        </button>
      </p>
      <div className="tiers" role="radiogroup" aria-label="Voice size">
        {TIER_ORDER.map((t: Tier) => {
          const info = TIERS[t];
          const blocked = advice.blocked[t];
          const chosen = b.tier === t;
          return (
            <button
              key={t}
              role="radio"
              aria-checked={chosen}
              disabled={!!blocked}
              className={`tier${chosen ? " chosen" : ""}`}
              onClick={() => e.setBuiltinTier(t)}
            >
              <span className="tier-head">
                <strong>{info.name}</strong>
                <span className="muted">{info.mb} MB</span>
                {advice.recommended === t && <span className="badge">Suits this device</span>}
                {b.stored.has(t) && <span className="badge ok">Downloaded</span>}
              </span>
              <span className="muted">{info.blurb}</span>
              {blocked && <span className="warn">{blocked}</span>}
              {!blocked && advice.caution[t] && <span className="warn">{advice.caution[t]}</span>}
            </button>
          );
        })}
      </div>
      {b.progress !== null && !b.ready && pct < 100 && (
        <>
          <div className="meter" role="img" aria-label={`Downloading ${pct}%`}>
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <p className="muted">Downloading the {TIERS[b.tier].name} voice… {pct}% (only once; keep this page open)</p>
        </>
      )}
      {b.ready && <p className="muted">✓ Ready{b.runsOn === "webgpu" ? " · running on the graphics chip" : ""}.</p>}
      {!b.ready && b.progress === null && (
        <button className="btn small-btn" onClick={() => b.warm(e.casting.Narrator)}>
          {b.stored.has(b.tier) ? "Get it ready" : `Download the ${TIERS[b.tier].name} voice (${TIERS[b.tier].mb} MB)`}
        </button>
      )}
      {b.stored.size > 0 && (
        <p className="muted">
          <button className="link-btn" onClick={() => confirm("Delete the downloaded on-device voices from this device?") && void b.deleteDownloads()}>
            Delete downloaded voices
          </button>
        </p>
      )}
    </div>
  );
}

/** Short name of the voice a speaker uses ("Heart" from "Heart · warm, American"). */
function voiceLabel(e: ReaderEngine, speaker: string): string {
  const id = e.casting[speaker] ?? e.casting.Narrator;
  const v = e.voicesFor().find((x) => x.id === id);
  return (v?.name ?? "Voice").replace(/^★\s*/, "").split(/ · | \(/)[0];
}

/** Touch the voice that's speaking → choose another one, heard at once. */
/**
 * The line being read, with the word the voice is on picked out. It follows the audio's
 * own progress, so it keeps pace with every voice and speed (see ReaderEngine.cursor).
 */
function LiveText({ e, i, text, open, close }: { e: ReaderEngine; i: number; text: string; open: string; close: string }) {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = -2;
    const tick = () => {
      const c = e.cursor();
      const pos = !c ? -1 : c.seg < i ? -1 : c.seg > i ? text.length : c.char;
      if (pos !== last) {
        last = pos;
        setAt(pos < 0 ? null : pos);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [e, i, text]);
  if (at === null) return <>{open}{text}{close}</>;
  if (at >= text.length) return <span className="spoken">{open}{text}{close}</span>;
  // The whole word around the cursor.
  let a = at, b = at;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return (
    <>
      <span className="spoken">{open}{text.slice(0, a)}</span>
      <span className="word-now">{text.slice(a, b)}</span>
      {text.slice(b)}{close}
    </>
  );
}

/** How the reading cursor behaves, and a timing nudge for the voice in use. */
function CursorSettings({ e }: { e: ReaderEngine }) {
  const voice = e.current?.voice || e.casting.Narrator || "";
  const shift = e.prefs.cursorShift[voice] ?? 0;
  return (
    <div className="cursor-settings small">
      <div className="row between">
        <span><strong>Reading cursor</strong> <span className="muted">follows each word as it is read</span></span>
        <div className="seg-toggle" role="radiogroup" aria-label="Reading cursor">
          <button role="radio" aria-checked={e.prefs.cursor === "word"} className={e.prefs.cursor === "word" ? "on" : ""} onClick={() => e.setPrefs({ cursor: "word" })}>Word</button>
          <button role="radio" aria-checked={e.prefs.cursor === "line"} className={e.prefs.cursor === "line" ? "on" : ""} onClick={() => e.setPrefs({ cursor: "line" })}>Line</button>
        </div>
      </div>
      {e.prefs.cursor === "word" && voice && (
        <div className="row between">
          <span className="muted">Cursor timing for this voice{shift ? ` · ${shift > 0 ? "+" : ""}${shift.toFixed(1)} s` : ""}</span>
          <span className="row gap-s">
            <button className="btn small-btn" onClick={() => e.shiftCursor(voice, -0.2)} aria-label="Cursor earlier">◀ Earlier</button>
            <button className="btn small-btn" onClick={() => e.shiftCursor(voice, 0.2)} aria-label="Cursor later">Later ▶</button>
          </span>
        </div>
      )}
    </div>
  );
}

function VoiceSheet({ e, speaker, onClose }: { e: ReaderEngine; speaker: string; onClose: () => void }) {
  const isCharacter = speaker !== "Narrator";
  // In one-voice mode a change applies to the whole book unless "only this character" is picked.
  const [onlyThem, setOnlyThem] = useState(isCharacter && !e.oneVoice);
  const target = onlyThem ? speaker : e.oneVoice ? "Narrator" : speaker;
  const voices = e.voicesFor();
  const chosen = e.casting[target] ?? e.casting.Narrator;
  const pick = (id: string) => {
    if (onlyThem && e.prefs.singleVoice) e.setPrefs({ singleVoice: false });
    e.setVoice(target, id);
    if (!e.playing) e.play();
  };
  const ch = isCharacter ? e.character(speaker) : undefined;
  return (
    <div className="modal-bg sheet-bg" onClick={onClose}>
      <div className="card modal voice-sheet" onClick={(x) => x.stopPropagation()} role="dialog" aria-label="Choose the voice">
        <div className="row between">
          <h3>Choose the voice</h3>
          <button className="icon small-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {isCharacter && (
          <div className="seg-toggle" role="radiogroup">
            <button role="radio" aria-checked={!onlyThem} className={!onlyThem ? "on" : ""} onClick={() => setOnlyThem(false)}>
              {e.oneVoice ? "Whole book" : "Narrator"}
            </button>
            <button role="radio" aria-checked={onlyThem} className={onlyThem ? "on" : ""} onClick={() => setOnlyThem(true)}>
              Only {speaker}
            </button>
          </div>
        )}
        <p className="muted small">
          {onlyThem
            ? `${speaker}${ch ? ` (${[ch.gender !== "neutral" ? ch.gender : "", ch.age !== "adult" ? ch.age : ""].filter(Boolean).join(", ") || "character"})` : ""} gets their own voice. Tap one to hear it now.`
            : "Tap a voice to hear it right away. It is kept for this book."}
        </p>
        <label className="field-inline small">
          <span className="muted">Kind of voice</span>
          <select value={e.provider} onChange={(x) => e.setProvider(x.target.value as Provider)}>
            {e.availableProviders().map((p) => (
              <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
            ))}
          </select>
        </label>
        <div className="voice-list">
          {voices.length === 0 && <p className="muted small">No voices for this kind on this device.</p>}
          {voices.map((v, i) => {
            const [name, ...rest] = v.name.replace(/^★\s*/, "").split(" · ");
            const header = v.more && !voices[i - 1]?.more;
            return (<Fragment key={v.id}>
              {header && <p className="muted small voice-group">More voices · a little less polished</p>}
              <button className={`voice-row${v.id === chosen ? " chosen" : ""}`} onClick={() => pick(v.id)}>
                <span className="voice-name">{name}</span>
                <span className="muted small">{[rest.join(" · "), v.gender !== "neutral" ? v.gender : ""].filter(Boolean).join(" · ")}</span>
                {v.id === chosen && <span className="tick" aria-label="chosen">{e.buffering ? <span className="spinner inline" /> : "✓"}</span>}
              </button>
            </Fragment>);
          })}
        </div>
      </div>
    </div>
  );
}

/** Invite to install Voicebook as an app on the phone (offline, keeps reading with the screen off). */
function isAndroid() {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

function InstallCard({ evt, installed }: { evt: { prompt: () => Promise<unknown> } | null; installed: boolean }) {
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <div className="install-card small">
      <p>
        <strong>📲 Put Voicebook on your phone</strong>
        <br />
        <span className="muted">Opens like an app, works offline with your saved books and downloaded voices, and keeps reading with the screen off.</span>
      </p>
      {!ios && /Android/i.test(typeof navigator !== "undefined" ? navigator.userAgent : "") && (
        <p>
          <a className="btn primary" href={ANDROID_APK_URL}>⬇ Android app (APK) · fastest</a>
          <br />
          <span className="muted">Runs the voice natively on your phone and keeps reading with the screen off. After the download, open the file and allow the install.</span>
        </p>
      )}
      {installed ? null : evt ? (
        <button className="btn" onClick={() => void evt.prompt()}>Or install the web app</button>
      ) : (
        <p className="muted">
          {ios ? "In Safari: tap Share, then “Add to Home Screen”." : "In Chrome: tap ⋮ (top right), then “Install app” or “Add to Home screen”."}
        </p>
      )}
    </div>
  );
}

/** The Android app's native phone voice: pick its size, download it once. */
function NativePanel({ e }: { e: ReaderEngine }) {
  const n = e.native;
  const info = n.info;
  return (
    <div className="studio-info small ondevice">
      <p>
        <strong>Phone AI voice.</strong> A natural voice made by this phone itself
        {info ? `, on ${info.threads} of its ${info.cores} processor cores` : ""}: works offline, no monthly limit, keeps reading with the screen off.
      </p>
      {n.error && <p className="tip">{n.error}</p>}
      <div className="tiers" role="radiogroup" aria-label="Voice size">
        {n.tiers.map((t) => {
          const s = n.status(t);
          const chosen = n.tier === t;
          return (
            <button key={t} role="radio" aria-checked={chosen} className={`tier${chosen ? " chosen" : ""}`} onClick={() => { n.setTier(t); e.setProvider("native"); }}>
              <span className="tier-head">
                <strong>{NATIVE_TIERS[t].name}</strong>
                <span className="muted">{s?.mb ?? "?"} MB</span>
                {n.recommended === t && <span className="badge">Suits this phone</span>}
                {s?.ready && <span className="badge ok">Downloaded</span>}
              </span>
              <span className="muted">{NATIVE_TIERS[t].blurb}</span>
              {s?.downloading && (
                <>
                  <span className="meter" role="img" aria-label={`Downloading ${Math.round(s.progress * 100)}%`}>
                    <span style={{ width: `${Math.max(2, Math.round(s.progress * 100))}%` }} />
                  </span>
                  <span className="muted">Downloading… {Math.round(s.progress * 100)}% (keep the app open)</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {!n.ready && !n.downloading && (
        <button className="btn small-btn" onClick={() => n.download()}>
          Download the {NATIVE_TIERS[n.tier].name} voice ({n.status()?.mb ?? "?"} MB)
        </button>
      )}
      {info && <p className="muted">App version {info.version} · <a href={ANDROID_APK_URL}>get the newest app</a></p>}
    </div>
  );
}

const IMPORTED_KEY = "vb:imported-files";
const importedKey = (name: string, size: number) => `${name}|${size}`;
function importedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}
function rememberImported(f: File) {
  try {
    const set = importedSet();
    set.add(importedKey(f.name, f.size));
    localStorage.setItem(IMPORTED_KEY, JSON.stringify([...set].slice(-5000)));
  } catch {}
}

/** Books found in a folder on the phone: pick which ones go into the library. */
function ScanDialog({ scan, onClose, onImport }: { scan: ScanResult; onClose: () => void; onImport: (f: FoundFile[]) => void }) {
  const done = importedSet();
  const fresh = (f: FoundFile) => !done.has(importedKey(f.name, f.size));
  // A scan you started yourself ticks everything (books already added just get their folder updated).
  const [picked, setPicked] = useState<Set<string>>(() => new Set(scan.files.filter((f) => !scan.auto || fresh(f)).map((f) => f.id)));
  const byFolder = new Map<string, FoundFile[]>();
  for (const f of scan.files) byFolder.set(f.folder, [...(byFolder.get(f.folder) ?? []), f]);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const mb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  return (
    <div className="modal-bg sheet-bg" onClick={onClose}>
      <div className="card modal voice-sheet" onClick={(x) => x.stopPropagation()} role="dialog" aria-label="Books found">
        <div className="row between">
          <h3>{scan.files.length ? `${scan.files.length} book${scan.files.length > 1 ? "s" : ""} found` : "No books found"}</h3>
          <button className="icon small-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted small">
          In {scan.folders.join(", ")}. PDF, EPUB and text files.
        </p>
        <div className="row gap">
          <button className="link-btn" onClick={() => setPicked(new Set(scan.files.map((f) => f.id)))}>Select all</button>
          <button className="link-btn" onClick={() => setPicked(new Set())}>None</button>
        </div>
        <div className="voice-list">
          {[...byFolder].map(([folder, files]) => (
            <div key={folder}>
              <p className="muted small voice-group">📁 {folder}</p>
              {files.map((f) => (
                <label key={f.id} className={`voice-row${picked.has(f.id) ? " chosen" : ""}`}>
                  <span className="voice-name">
                    <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} /> {f.name.replace(/\.[^.]+$/, "")}
                  </span>
                  <span className="muted small">{f.name.split(".").pop()?.toUpperCase()} · {mb(f.size)}{fresh(f) ? "" : " · already added (folder updated)"}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <button className="btn primary" disabled={!picked.size} onClick={() => onImport(scan.files.filter((f) => picked.has(f.id)))}>
          Add {picked.size} book{picked.size === 1 ? "" : "s"} to my library
        </button>
      </div>
    </div>
  );
}
