import { getAccess, denied } from "@/lib/access";
import { heuristicAnalyze } from "@/lib/heuristic";
import { ANALYZE_SYSTEM, analyzeUserMessage } from "@/lib/prompts";
import {
  AMBIENCES,
  MOODS,
  EMOTIONS,
  GENRES,
  type Analysis,
  type Character,
  type Emotion,
  type Genre,
  type RawSegment,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").length;

function normalize(raw: any, sourceText: string, known: Character[]): Analysis {
  const genre: Genre = GENRES.includes(raw?.genre) ? raw.genre : "other";
  const characters: Character[] = (Array.isArray(raw?.characters) ? raw.characters : [])
    .filter((c: any) => c && typeof c.name === "string" && c.name.trim())
    .map((c: any) => ({
      name: String(c.name).trim().slice(0, 60),
      gender: ["male", "female"].includes(c.gender) ? c.gender : "neutral",
      age: ["child", "young", "elderly"].includes(c.age) ? c.age : "adult",
      traits: typeof c.traits === "string" ? c.traits.slice(0, 120) : undefined,
      accent: typeof c.accent === "string" ? c.accent.slice(0, 30) : "",
    }));
  let segments: RawSegment[] = (Array.isArray(raw?.segments) ? raw.segments : [])
    .filter((s: any) => s && typeof s.text === "string" && s.text.trim())
    .map((s: any) => ({
      speaker: typeof s.speaker === "string" && s.speaker.trim() ? s.speaker.trim().slice(0, 60) : "Narrator",
      text: s.text.trim(),
      emotion: (EMOTIONS as readonly string[]).includes(s.emotion) ? (s.emotion as Emotion) : "neutral",
      delivery: typeof s.delivery === "string" ? s.delivery.slice(0, 120) : "",
      sfx: typeof s.sfx === "string" ? s.sfx.slice(0, 80) : "",
    }));

  // Safety net: if the model dropped too much text, fall back to the plain split
  // (keeps the AI's genre and characters, so voices still work).
  const covered = letters(segments.map((s) => s.text).join(""));
  if (covered < letters(sourceText) * 0.8) {
    segments = heuristicAnalyze(sourceText, known).segments;
  }

  return {
    genre,
    language: typeof raw?.language === "string" ? raw.language.slice(0, 8) : "",
    narrationStyle: typeof raw?.narrationStyle === "string" ? raw.narrationStyle.slice(0, 300) : "",
    characters,
    segments,
    scene: {
      ambience: (AMBIENCES as readonly string[]).includes(raw?.scene?.ambience) ? raw.scene.ambience : "none",
      music: (MOODS as readonly string[]).includes(raw?.scene?.music) ? raw.scene.music : "none",
    },
  };
}

export async function POST(req: Request) {
  const access = await getAccess(req);
  if (!access.ok) return denied(access);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return Response.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 501 });

  const body = await req.json().catch(() => null);
  const text = String(body?.text ?? "").slice(0, 12000);
  if (!text.trim()) return Response.json({ error: "No text" }, { status: 400 });
  const known: Character[] = Array.isArray(body?.knownCharacters) ? body.knownCharacters.slice(0, 80) : [];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
      max_tokens: 16000,
      system: ANALYZE_SYSTEM,
      messages: [{ role: "user", content: analyzeUserMessage(text, known, body?.context ?? null) }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("Anthropic error", res.status, detail.slice(0, 500));
    return Response.json({ error: `AI analysis failed (${res.status})` }, { status: 502 });
  }

  const data = await res.json();
  const out: string = (data.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  let parsed: any = null;
  try {
    parsed = JSON.parse(out.slice(start, end + 1));
  } catch {
    console.error("Could not parse analysis JSON");
  }
  return Response.json(normalize(parsed, text, known));
}
