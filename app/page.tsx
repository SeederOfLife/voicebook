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

const PROVIDER_LABEL: Record<Provider, string> = {
  studio: "Studio voice",
  elevenlabs: "ElevenLabs · acting voices",
  openai: "OpenAI · acting voices",
  builtin: "On-device AI voice",
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
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refreshBooks = useCallback(() => library.list().then(setBooks), []);

  const loadConfig = useCallback(async (e: ReaderEngine) => {
    let c: AppConfig;
    try {
      const r = await fetch("/api/config", { headers: e.headers() });
      if (!r.ok) throw new Error(String(r.status));
      c = await r.json();
    } catch {
      c = OFFLINE_CONFIG; // no connection (or the server is down): open anyway
    }
    setCfg(c);
    e.setConfig(c);
    return c;
  }, []);

  // Installable app + offline: register the service worker, catch Chrome's install prompt.
  const [installEvt, setInstallEvt] = useState<{ prompt: () => Promise<unknown> } | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
    if ("serviceWorker" in navigator && location.hostname !== "localhost") navigator.serviceWorker.register("/sw.js").catch(() => {});
    const onPrompt = (ev: Event) => {
      ev.preventDefault();
      setInstallEvt(ev as unknown as { prompt: () => Promise<unknown> });
    };
    const onInstalled = () => { setInstalled(true); setInstallEvt(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  useEffect(() => {
    const e = new ReaderEngine(() => setTick((t) => t + 1));
    engineRef.current = e;
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

  const openBook = async (title: string, sections: { title: string; text: string }[]) => {
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
      addedAt: Date.now(),
      openedAt: Date.now(),
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

  const onFile = async (file: File) => {
    setLoadError(null);
    setBusy("Reading file…");
    try {
      const book = await extractText(file, (p) => setBusy(`Reading PDF… ${Math.round(p * 100)}%`));
      await openBook(book.title, book.sections);
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
    const r = await fetch("/api/checkout", { method: "POST", headers: e.headers() });
    const d = await r.json();
    if (d.url) location.href = d.url;
    else setAuthMsg(d.error ?? "Could not start checkout");
  };

  const openPortal = async () => {
    if (!e) return;
    const r = await fetch("/api/portal", { method: "POST", headers: e.headers() });
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
          {!signedOut && (
            <select
              className="provider"
              value={e.provider}
              onChange={(x) => e.setProvider(x.target.value as Provider)}
              aria-label="Voice engine"
            >
              {e.availableProviders().map((p) => (
                <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
              ))}
              {e.lockedProviders().map((p) => (
                <option key={p} value={p}>🔒 {PROVIDER_LABEL[p]}</option>
              ))}
            </select>
          )}
          {cfg.mode === "accounts" && (
            <button className="avatar" onClick={() => setModal(cfg.user ? "account" : "signin")} aria-label="Account">
              {cfg.user ? cfg.user.email[0].toUpperCase() : "→"}
              {premium && <span className="crown">★</span>}
            </button>
          )}
        </div>
      </header>

      {/* ---------- Home / library ---------- */}
      {!hasBook && (
        <section className="hero">
          <h1>Any book, read to you <em>in a studio voice.</em></h1>
          <p className="muted">
            Drop in a PDF, EPUB or text and press play. Voicebook finds the chapters, remembers where you stopped,
            and keeps the audio on your device so it never has to be made twice.
          </p>

          {signedOut ? (
            <div className="card">
              <h3 className="card-title">Sign in to start listening</h3>
              {signInForm}
            </div>
          ) : (
            <>
              {books.length > 0 && (
                <div className="library">
                  <h3 className="section-label">Continue listening</h3>
                  {books.map((b) => {
                    const ch = [...b.chapters].reverse().find((c) => c.chunk <= b.position.chunk);
                    const pct = Math.round((b.position.chunk / Math.max(1, b.total)) * 100);
                    return (
                      <div key={b.id} className="book-row">
                        <button className="book-open" onClick={() => resumeBook(b.id)}>
                          <span className="book-cover" style={{ background: `hsl(${hash(b.title) % 360} 35% 30%)` }}>
                            {b.title[0]}
                          </span>
                          <span className="book-info">
                            <strong>{b.title}</strong>
                            <span className="muted small">{ch?.title ? `${ch.title} · ` : ""}{pct}% · {timeAgo(b.openedAt)}</span>
                            <span className="mini-bar"><span style={{ width: `${pct}%` }} /></span>
                          </span>
                          <span className="resume">▶</span>
                        </button>
                        <button
                          className="icon-btn subtle"
                          aria-label={`Remove ${b.title}`}
                          onClick={async () => {
                            if (confirm(`Remove “${b.title}” from your library?`)) {
                              await library.remove(b.id);
                              refreshBooks();
                            }
                          }}
                        >✕</button>
                      </div>
                    );
                  })}
                </div>
              )}

              <button className="dropzone" onClick={() => fileRef.current?.click()} disabled={!!busy}
                onDragOver={(x) => x.preventDefault()}
                onDrop={(x) => { x.preventDefault(); const f = x.dataTransfer.files[0]; if (f) onFile(f); }}>
                {busy ? <><div className="spinner" /> {busy}</> : <>
                  <span className="drop-icon">📖</span>
                  <strong>Add a book</strong>
                  <span className="muted small">PDF · EPUB · TXT · Markdown · HTML</span>
                </>}
              </button>
              <input ref={fileRef} type="file" hidden accept=".pdf,.epub,.txt,.md,.markdown,.html,.htm,application/pdf,text/plain"
                onChange={(x) => { const f = x.target.files?.[0]; if (f) onFile(f); x.target.value = ""; }} />

              <div className="row gap">
                <button className="btn" onClick={() => setShowPaste((s) => !s)}>Paste text</button>
                <button className="btn" onClick={() => openBook("The Lighthouse Keeper", detectSections(SAMPLE))}>Try a sample story</button>
              </div>
              {!installed && <InstallCard evt={installEvt} />}
              {showPaste && (
                <div className="paste">
                  <textarea value={paste} onChange={(x) => setPaste(x.target.value)} placeholder="Paste any text here…" rows={8} />
                  <button className="btn primary" disabled={!paste.trim()}
                    onClick={() => openBook(paste.trim().split("\n")[0].slice(0, 50) || "Pasted text", detectSections(paste))}>Read it</button>
                </div>
              )}
              {loadError && <p className="error">{loadError}</p>}

              {!premium && cfg.mode === "accounts" && (
                <button className="card premium-teaser" onClick={() => (e.premiumPrompt = true, setTick((t) => t + 1))}>
                  <strong>★ Premium</strong>
                  <span className="muted small">Lifelike expressive voices, accents, sound effects, ambience &amp; background music.</span>
                </button>
              )}

              <div className="status-list small">
                <span className={cfg.providers.studio ? "ok" : "off"}>Studio voice</span>
                <span className={cfg.providers.anthropic ? "ok" : "off"}>Characters &amp; emotions (AI key)</span>
                <span className={cfg.providers.elevenlabs || cfg.providers.openai ? "ok" : "off"}>Acting voices (voice key)</span>
              </div>
            </>
          )}
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

            {panel === "cast" && (
              <section className="cast card">
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
              <section className="card sound">
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
                return (
                  <span key={s.id}>
                    {newPart && <span className="part-break" aria-hidden>{chapterStart.title}</span>}
                    {s.para && !firstOfPart && !heading && <span className="para-break" aria-hidden />}
                    <span
                      ref={i === e.index ? activeRef : undefined}
                      className={`seg ${active ? "active" : ""} ${heading ? "heading" : ""} ${cast && s.speaker !== "Narrator" ? "dialogue" : ""}`}
                      style={cast && s.speaker !== "Narrator" ? { ["--c" as string]: speakerColor(s.speaker) } : undefined}
                      onClick={() => (active && e.playing ? setVoiceSheet(s.speaker) : e.jump(i))}
                      title={cast ? `${s.speaker} · ${s.emotion}${s.delivery ? ` · ${s.delivery}` : ""}${s.sfx ? ` · 🔊 ${s.sfx}` : ""}` : undefined}
                    >
                      {cast && s.speaker !== "Narrator" && <span className="who">{s.speaker}{EMOTION_ICON[s.emotion] ? ` ${EMOTION_ICON[s.emotion]}` : ""}</span>}
                      {s.sfx && premium && e.prefs.sfx && cfg.providers.elevenlabs && <span className="sfx">🔊</span>}
                      {!cast && s.quote ? `${s.quote & 1 ? "“" : ""}${s.text}${s.quote & 2 ? "”" : ""}` : s.text}
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
                <span className="dl">{e.waitMessage}{waitedFor >= 3 ? ` ${waitedFor}s` : ""}</span>
              ) : current ? (
                <>
                  <button className="voice-chip" onClick={() => setVoiceSheet(current.speaker)} aria-label="Change the voice">
                    🎙 {voiceLabel(e, e.oneVoice ? "Narrator" : current.speaker)} ▾
                  </button>
                  <span className="sep">·</span>
                  <button className="link-btn" onClick={() => setSidebar(true)}>{e.chapters[chapterIdx]?.title ?? `part ${current.chunk + 1}`}</button>
                  <span className="sep">·</span>{Math.round(progress * 100)}%
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
              <button className="icon small-icon" onClick={() => setSidebar(true)} aria-label="Chapters">☰</button>
            </div>
          </footer>
        </div>
      )}

      {/* ---------- Modals ---------- */}
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
function InstallCard({ evt }: { evt: { prompt: () => Promise<unknown> } | null }) {
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <div className="install-card small">
      <p>
        <strong>📲 Put Voicebook on your phone</strong>
        <br />
        <span className="muted">Opens like an app, works offline with your saved books and downloaded voices, and keeps reading with the screen off.</span>
      </p>
      {evt ? (
        <button className="btn primary" onClick={() => void evt.prompt()}>Install the app</button>
      ) : (
        <p className="muted">
          {ios ? "In Safari: tap Share, then “Add to Home Screen”." : "In Chrome: tap ⋮ (top right), then “Install app” or “Add to Home screen”."}
        </p>
      )}
    </div>
  );
}
