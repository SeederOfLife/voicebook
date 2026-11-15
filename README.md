# 🎧 Voicebook — AI audiobook reader

**Live:** https://voicebook-lake.vercel.app

Upload a **PDF, EPUB, TXT, Markdown or HTML** and listen to it like a real audiobook:

- **Studio voice, no key needed.** A studio-quality neural voice (Kokoro, full precision) is generated on the app's own server, so it works on every device, phones included. It reads English, in 12 curated voices; one voice reads everything by default, or each character can have their own.
- **Audio is saved on the device.** Every passage is generated once, then kept (as MP3, about 36 MB per hour), so replaying is instant, works without a connection, and never costs server time twice.
- **Chapters sidebar.** It uses the PDF bookmarks, the EPUB chapters, or headings like "Chapter 3" / "Kapitola 2" / "Chapitre 4". Tap a chapter to jump to it.
- **Remembers your place.** Each book is saved on the device with the passage you stopped at, plus your voice choices. Open the app and tap *Continue listening*.
- **Background sound that serves the story.** Scene sounds (rain, storm, sea, fire, forest, night, city, cave) set the scene and then settle; music comes in only at key moments (a chapter opening, a change of mood, an intense line) unless you ask for it all the time.
- **Optional, with your own keys:** AI analysis of characters and emotions (Anthropic), acting voices that perform each line (ElevenLabs v3 or OpenAI), sound effects (ElevenLabs).
- Works on phones: lock-screen controls, speed control, and it keeps reading with the screen off.

---

## 1. Put it on GitHub

1. Create a new repository on [github.com/new](https://github.com/new) (e.g. `voicebook`).
2. Upload the project files: on the repo page click **"uploading an existing file"**, drag in everything from this folder **except `node_modules` and `.next`**, then commit.
   Or from a computer: `git init && git add . && git commit -m "Voicebook" && git branch -M main && git remote add origin https://github.com/YOU/voicebook.git && git push -u origin main`

## 2. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repo. Leave the defaults (Next.js is detected automatically).
2. Before clicking **Deploy**, add **Environment Variables** (see below).
3. Deploy. From then on, **every push to GitHub redeploys automatically**, so to update the app you just edit the files on GitHub.

## 3. Environment variables

| Variable | What it does | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI analysis: genre, characters, who speaks, emotions, scenes, sound effects | console.anthropic.com |
| `ELEVENLABS_API_KEY` | Most expressive voices (Eleven v3 with emotion tags) **+ sound effects** | elevenlabs.io → Profile → API keys |
| `OPENAI_API_KEY` | Expressive voices steered by acting directions (gpt-4o-mini-tts) | platform.openai.com |
| `APP_PASSWORD` | *(personal mode)* protects your app so nobody else uses your credits | anything you choose |

None of these are required: without any key the app reads in the **studio voice**.

### The studio voice and its monthly allowance

The studio voice runs inside a Vercel Function (`/api/voice`): the first request downloads the voice model (326 MB) into the function's temp folder, which takes 10–20 seconds; after that a passage is generated in roughly the time it takes to listen to it, so the app prepares passages ahead of the listener.

Generating speech uses server computing time: about one CPU-second per second of audio. **Vercel's free (Hobby) plan includes 4 CPU-hours a month**, and if an account goes over, its functions stop until the period resets. To stay clear of that, each device stops asking for new studio audio after **3 CPU-hours a month (roughly 3 hours of new audio)** and reads with the device's own voice until the month is over; audio already saved keeps playing in the studio voice. This guard is per device, so it is a safety net rather than an exact meter.

| Variable | What it does |
|---|---|
| `STUDIO_MONTHLY_HOURS` | Monthly allowance per device in CPU-hours. Default `3`. On a paid Vercel plan (where extra CPU time costs about $0.13 per hour) set it higher, or `0` for no limit. |
| `STUDIO_VOICE` | `off` switches the studio voice off. |
| `KOKORO_MODEL` | `fp32` (default when the function has 2 GB of memory) or `q8` (smaller, slightly less clean). |

On computers the same voice can also be generated inside the browser ("Studio voice · made on this computer": a 90 MB download, no server time). Phones and tablets don't have the memory for that. Books in other languages are read by the device's own voice, or by the acting voices if you add a key.

Optional: `ANTHROPIC_MODEL` (default `claude-haiku-5-5`; `claude-sonnet-5-5` is better at spotting characters), `ELEVENLABS_MODEL` (default `eleven_v3`), `ELEVENLABS_SFX_MODEL` (default `eleven_text_to_sound_v3`), `OPENAI_TTS_MODEL`.

### Personal mode vs. accounts mode

- **Open mode** (default): every feature is unlocked for everyone who opens the app, with no sign-in. Anyone with the link uses *your* server time and API credits, so set `APP_PASSWORD` unless you want that.
- **Accounts mode**: turns on only when you set `PAYWALL=on` **and** the Supabase variables below. Visitors sign in (email link or Google). Free users get device voices plus the AI analysis; **Premium** users get the AI voices, accents, sound effects, ambience and music.

## 4. Accounts (Supabase), optional

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste and run [`supabase/schema.sql`](supabase/schema.sql).
3. **Authentication → URL Configuration** → set *Site URL* to your Vercel URL (e.g. `https://voicebook.vercel.app`).
4. *(Optional)* **Authentication → Providers → Google** to enable "Continue with Google".
5. Add to Vercel (from **Project Settings → API**):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` / secret key (**never share it**) |
| `PREMIUM_EMAILS` | your email(s), comma-separated: always Premium for free |

## 5. Payments (Stripe), optional

1. In [Stripe](https://dashboard.stripe.com), create a **Product** "Voicebook Premium" with a monthly **recurring price**. Copy the price ID (`price_…`).
2. **Developers → Webhooks → Add endpoint**: `https://YOUR-APP.vercel.app/api/stripe-webhook`
   Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
3. Add to Vercel: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` (shown on the webhook page).
4. Turn on the **Customer portal** (Settings → Billing → Customer portal) so users can cancel or change their card.

Redeploy after changing environment variables (Vercel → Deployments → ⋯ → Redeploy).

---

## How it works

```
Book file ─► (browser) extract text + chapters ─► split into parts
                                                       │
                     /api/analyze (Claude) ◄───────────┘  one part at a time, just ahead of you
     genre · characters · speaker + emotion per line · scene · sound effects
                                                       │
   lines are grouped into passages (a few sentences, cut the same way every time)
                                                       │
   /api/voice (studio voice, on this server)  ·  /api/tts (ElevenLabs v3 / OpenAI)  ·  device voice
                  + /api/sfx (ElevenLabs)  + live-generated ambience & music (Web Audio)
                                                       │
            player: prepares passages ahead, saves the audio, chapters, resume
```

- **Analysis is saved per book** on the device, so reopening a book or jumping back is instant and isn't charged twice.
- **Files stay on your device.** Books are read in the browser and saved locally (IndexedDB). Only the passage being prepared is sent for analysis or speech.
- **Ambience and music are generated live** with the Web Audio API: no audio files, no licensing, no extra cost.
- **Costs**: the studio voice costs nothing within the allowance above. With your own keys, analysis costs a few cents per book with Haiku; acting voices are the main cost: ElevenLabs charges per character, OpenAI is cheaper. A 300-page novel is about 600k characters, so try the sample first.
- **Troubleshooting the studio voice**: open `/api/voice?test=1` in a browser. It loads the voice model, speaks one sentence and answers `"ok": true` with the timings, or `"ok": false` with the reason. Plain `/api/voice` shows the current state without running anything.
- Scanned PDFs (photos of pages) have no text layer and aren't supported. Use a text PDF or an EPUB.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in keys
npm run dev                  # http://localhost:3000
```

## Where to change things

| Want to… | Edit |
|---|---|
| Change how the AI reads / casts | `lib/prompts.ts` |
| Change the studio voices on offer | `lib/voices.ts` (`STUDIO_VOICES`) |
| Change how the studio voice is generated (pauses, batching, level) | `lib/studio/kokoro.ts` |
| Change passage length and what is prepared ahead | `lib/engine.ts` (`PASSAGE_CHARS`, `RAMP`, `AHEAD`) |
| Change default voices per genre | `lib/voices.ts` (`NARRATOR_PREFS`) |
| Change ambience/music sounds | `lib/soundscape.ts` |
| Change what Free vs Premium gets | `lib/access.ts`, `app/api/tts/route.ts`, `lib/engine.ts` |
| Change the look | `app/globals.css`, `app/page.tsx` |

## The on-device AI voice (three sizes)

Choose **On-device AI voice** in the engine menu. The voice is made by the listener's own device, so after one download it works offline and has no monthly limit. The app checks the device (phone or computer, memory, processor cores, graphics chip and a short speed test), lets the listener say which device it is, and suggests a size:

| Size | Download | Model | For |
|---|---|---|---|
| Light | 63 MB per voice | Piper (medium) | phones, tablets, older computers |
| Balanced | 92 MB | Kokoro v1.0, 8-bit | recent computers (experimental on recent phones) |
| Best | 326 MB | Kokoro v1.0, full precision, WebGPU when available | powerful computers |

Voices are downloaded from Hugging Face once and kept in the browser's storage ("Delete downloaded voices" removes them). On phones, if the page closes while a bigger size loads, the app goes back to Light by itself next time.
