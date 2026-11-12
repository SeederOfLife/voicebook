"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildBook, detectSections } from "@/lib/chunk";
import { ReaderEngine } from "@/lib/engine";
import { extractText } from "@/lib/extract";
import { bookId, library, type BookRecord, type BookSummary } from "@/lib/library";
import { getSupabase } from "@/lib/supabase-browser";
import { ACCENTS, type AppConfig, type Provider } from "@/lib/types";
import { hash } from "@/lib/voices";

const PROVIDER_LABEL: Record<Provider, string> = {
  elevenlabs: "ElevenLabs · most expressive",
  openai: "OpenAI · expressive",
  builtin: "Built-in AI voices · free",
  browser: "Device voices · free",
};

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
  const [modal, setModal] = useState<"none" | "account" | "signin">("none");
  const [email, setEmail] = useState("");
  const [authMsg, setAuthMsg] = useState<string | null>(null);
  const activeRef = useRef<HTMLSpanElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refreshBooks = useCallback(() => library.list().then(setBooks), []);

  const loadConfig = useCallback(async (e: ReaderEngine) => {
    const r = await fetch("/api/config", { headers: e.headers() });
    const c: AppConfig = await r.json();
    setCfg(c);
    e.setConfig(c);
    return c;
  }, []);

  useEffect(() => {
    const e = new ReaderEngine(() => setTick((t) => t + 1));
    engineRef.current = e;
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
        setLoadError("Could not reach the server.");
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
  const voiceGroups = e.voiceGroups();
  const deviceVoices = e.provider === "browser";
  const speakers = e.oneVoice ? ["Narrator"] : ["Narrator", ...e.characters.map((c) => c.name)];
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
          <h1>Books that read themselves <em>like a performance.</em></h1>
          <p className="muted">
            Drop in a PDF, EPUB or text. The AI works out if it&apos;s a story, a guide or an article, finds the
            characters, and gives each one a voice — with the emotion in every line.
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
                <span className={cfg.providers.anthropic ? "ok" : "off"}>AI story analysis</span>
                <span className={cfg.providers.elevenlabs ? "ok" : "off"}>ElevenLabs voices + FX</span>
                <span className={cfg.providers.openai ? "ok" : "off"}>OpenAI voices</span>
                <span className="ok">Ambience &amp; music</span>
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
                {!e.aiUsed && e.aiUnavailable && <span className="chip warn">Basic mode (no AI analysis)</span>}
                <button className={`chip link ${panel === "cast" ? "on" : ""}`} onClick={() => setPanel((p) => (p === "cast" ? "none" : "cast"))}>
                  🎭 {e.oneVoice ? "Voice" : `Voices (${e.characters.length + 1})`}
                </button>
                <button className={`chip link ${panel === "sound" ? "on" : ""}`} onClick={() => setPanel((p) => (p === "sound" ? "none" : "sound"))}>
                  🎵 Sound {premium ? "" : "🔒"}
                </button>
              </div>
              {e.meta.narrationStyle && <p className="muted small style">🎙️ {e.meta.narrationStyle}</p>}
            </section>

            {panel === "cast" && (
              <section className="cast card">
                {e.builtinIsOptional && (
                  <label className="toggle">
                    <input type="checkbox" checked={e.builtinOn} onChange={(x) => e.setBuiltin(x.target.checked)} /> Built-in AI voices
                    <span className="muted small">
                      Experimental on phones: downloads about 90 MB once and needs a lot of memory. If the page closes itself, it will be switched off again automatically. English books only.
                    </span>
                  </label>
                )}
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
                    <label className="toggle">
                      <input type="checkbox" checked={e.prefs.singleVoice} onChange={(x) => e.setPrefs({ singleVoice: x.target.checked })} /> One voice reads everything
                      <span className="muted small">The most natural. Turn off to give each character their own voice.</span>
                    </label>
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
                          className={deviceVoices ? "span2" : ""}
                          value={e.casting[name] ?? ""}
                          onChange={(x) => e.setVoice(name, x.target.value)}
                          aria-label={`Voice for ${name}`}
                        >
                          {voiceGroups.map((g) => {
                            const opts = g.voices.map((v) => (
                              <option key={v.id} value={v.id}>{v.name}{v.gender !== "neutral" ? ` (${v.gender[0].toUpperCase()})` : ""}</option>
                            ));
                            return g.label ? <optgroup key={g.label} label={g.label}>{opts}</optgroup> : opts;
                          })}
                        </select>
                        {!deviceVoices && (
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
                    <label className="toggle"><input type="checkbox" checked={e.prefs.ambience} onChange={(x) => e.setPrefs({ ambience: x.target.checked })} /> Ambience <span className="muted small">rain, sea, fire, forest… chosen from the scene</span></label>
                    <label className="toggle"><input type="checkbox" checked={e.prefs.music} onChange={(x) => e.setPrefs({ music: x.target.checked })} /> Background music <span className="muted small">follows the mood</span></label>
                    <label className="toggle">
                      <input type="checkbox" checked={e.prefs.sfx} disabled={!cfg.providers.elevenlabs} onChange={(x) => e.setPrefs({ sfx: x.target.checked })} /> Sound effects
                      <span className="muted small">{cfg.providers.elevenlabs ? "thunder, doors, footsteps…" : "needs an ElevenLabs key"}</span>
                    </label>
                    <label className="slider">Background volume
                      <input type="range" min={0} max={1} step={0.05} value={e.prefs.bgVolume} onChange={(x) => e.setPrefs({ bgVolume: Number(x.target.value) })} />
                    </label>
                  </>
                )}
              </section>
            )}

            <article className="reader">
              {e.segments.length === 0 && (
                <p className="muted center-text"><span className="spinner inline" /> Analysing the text, finding characters and emotions…</p>
              )}
              {e.segments.map((s, i) => {
                const prev = e.segments[i - 1];
                const chapterStart = e.chapters.find((c) => c.chunk === s.chunk);
                const newPart = (i === 0 || prev.chunk !== s.chunk) && chapterStart && !s.text.startsWith(chapterStart.title.split(" — ")[0]);
                const active = i === e.index || (e.playing && i > e.index && i <= e.groupEnd);
                return (
                  <span key={s.id}>
                    {newPart && <span className="part-break" aria-hidden>{chapterStart.title}</span>}
                    <span
                      ref={i === e.index ? activeRef : undefined}
                      className={`seg ${active ? "active" : ""} ${s.speaker !== "Narrator" ? "dialogue" : ""}`}
                      style={s.speaker !== "Narrator" ? { ["--c" as string]: speakerColor(s.speaker) } : undefined}
                      onClick={() => e.jump(i)}
                      title={`${s.speaker} · ${s.emotion}${s.delivery ? ` · ${s.delivery}` : ""}${s.sfx ? ` · 🔊 ${s.sfx}` : ""}`}
                    >
                      {s.speaker !== "Narrator" && <span className="who">{s.speaker}{EMOTION_ICON[s.emotion] ? ` ${EMOTION_ICON[s.emotion]}` : ""}</span>}
                      {s.sfx && premium && e.prefs.sfx && <span className="sfx">🔊</span>}
                      {s.text}
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
                {e.availableProviders().length > 1 && <> — try another voice engine at the top.</>}
              </p>
            )}
            <div className="now muted small">
              {current ? (
                <>
                  <span className="dot" style={{ background: speakerColor(current.speaker) }} /> {current.speaker}
                  {current.emotion !== "neutral" && <> · {current.emotion}</>}
                  <span className="sep">·</span>
                  <button className="link-btn" onClick={() => setSidebar(true)}>{e.chapters[chapterIdx]?.title ?? `part ${current.chunk + 1}`}</button>
                </>
              ) : "Getting ready…"}
              {e.provider === "builtin" && e.builtin.progress !== null && !e.builtin.ready && (
                <span className="dl"> · downloading voice pack {Math.round(e.builtin.progress * 100)}% (one time)</span>
              )}
            </div>
            <div className="controls">
              <select className="speed" value={e.rate} onChange={(x) => e.setRate(Number(x.target.value))} aria-label="Speed">
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
              <button className="icon" onClick={() => e.jump(e.index - 1)} aria-label="Previous">⏮</button>
              <button className="play" onClick={() => e.toggle()} disabled={e.segments.length === 0} aria-label={e.playing ? "Pause" : "Play"}>
                {e.buffering ? <span className="spinner" /> : e.playing ? "❚❚" : "▶"}
              </button>
              <button className="icon" onClick={() => e.jump(e.index + 1)} aria-label="Next">⏭</button>
              <button className="icon small-icon" onClick={() => setSidebar(true)} aria-label="Chapters">☰</button>
            </div>
          </footer>
        </div>
      )}

      {/* ---------- Modals ---------- */}
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
              <p className="muted small">Everything is unlocked. Lifelike AI voices need a voice API key (ElevenLabs or OpenAI) on the server.</p>
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
