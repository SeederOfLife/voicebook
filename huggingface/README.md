---
title: Voicebook voice server
emoji: 📖
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

The server part of [Voicebook](https://seederoflife.github.io/voicebook/): the studio
voice (Kokoro v1.0, full precision) and the AI casting/analysis. The app itself is on
GitHub Pages and calls this Space.

Settings → Variables and secrets (optional): `GEMINI_API_KEY` (free, from Google AI
Studio) for the AI casting; `APP_PASSWORD` to keep the server private.
