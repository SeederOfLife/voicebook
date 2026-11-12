# 🎧 Voicebook — AI audiobook reader

**Live:** https://voicebook-lake.vercel.app

Upload a **PDF, EPUB, TXT, Markdown or HTML** and listen to it like a real audiobook:

- **Adapts to the content.** The AI finds out if it's a novel, a children's story, a guide, a textbook, news or poetry, and changes the narration style to match.
- **A voice for each character.** It works out who is speaking and gives every character their own voice (by gender, age and personality). You can change any voice yourself.
- **Emotion and intonation.** Each line is tagged *sad, angry, whispering, excited, fearful…*, and the voice performs it.
- **Chapters sidebar.** It uses the PDF bookmarks, the EPUB chapters, or headings like "Chapter 3" / "Kapitola 2" / "Chapitre 4". Tap a chapter to jump to it.
- **Remembers your place.** Each book is saved on the device with the exact sentence you stopped at, plus your voice choices. Open the app and tap *Continue listening*.
- **All included:** expressive AI voices, accents, sound effects, ambience that follows the scene (rain, storm, sea, fire, forest, night, city, cave) and background music that follows the mood.
- Works on phones: lock-screen controls, speed control, and it keeps reading while you scroll.

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

You need **at least the Anthropic key** for the smart features. Without any keys the app still works in "basic mode": free device voices, dialogue/narration split, pitch changes for emotions and keyword-based ambience.

Optional: `ANTHROPIC_MODEL` (default `claude-haiku-5-5`; `claude-sonnet-5-5` is better at spotting characters), `ELEVENLABS_MODEL` (default `eleven_v3`), `ELEVENLABS_SFX_MODEL` (default `eleven_text_to_sound_v3`), `OPENAI_TTS_MODEL`.

### Personal mode vs. accounts mode

- **Open mode** (default): every feature is unlocked for everyone who opens the app, with no sign-in. Anyone with the link uses *your* API credits, so set `APP_PASSWORD` unless you want that.
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
       /api/tts (ElevenLabs v3 / OpenAI)  or device voices (free)
                  + /api/sfx (ElevenLabs)  + live-generated ambience & music (Web Audio)
                                                       │
                                     player: prefetch, highlight, chapters, resume
```

- **Analysis is saved per book** on the device, so reopening a book or jumping back is instant and isn't charged twice.
- **Files stay on your device.** Books are read in the browser and saved locally (IndexedDB). Only the passage being prepared is sent for analysis or speech.
- **Ambience and music are generated live** with the Web Audio API: no audio files, no licensing, no extra cost.
- **Costs** (your API accounts): analysis costs a few cents per book with Haiku. Voices are the main cost: ElevenLabs charges per character, OpenAI is cheaper. A 300-page novel is about 600k characters, so try the sample first.
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
| Change default voices per genre | `lib/voices.ts` (`NARRATOR_PREFS`) |
| Change ambience/music sounds | `lib/soundscape.ts` |
| Change what Free vs Premium gets | `lib/access.ts`, `app/api/tts/route.ts`, `lib/engine.ts` |
| Change the look | `app/globals.css`, `app/page.tsx` |
