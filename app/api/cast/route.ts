import { getAccess, denied } from "@/lib/access";
import { AiError, aiProvider, askJson } from "@/lib/llm";
import { STUDIO_VOICES } from "@/lib/voices";
import type { Character } from "@/lib/types";

// Whole-book casting: the AI reads what the on-device scan found (names, a few lines each,
// the opening of the book) and returns the real cast: merged nicknames, man/woman, age,
// personality, and a fitting voice. Characters already cast in other books of the same
// author or series keep their voice.

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM = `You are the casting director of an audiobook studio. You receive a list of names that a simple program found in a book (it can contain mistakes: places, titles, words that are not people, duplicates, nicknames of the same person), with sample lines each one speaks, and the opening of the book.

Return the real speaking characters as JSON:
{"characters":[{"name":"...","aliases":["..."],"gender":"male|female|neutral","age":"child|young|adult|elderly","traits":"...","importance":"main|supporting|minor","voice":"..."}]}

Rules:
- One entry per person. Merge nicknames, titles and full names ("Paul", "Paul Atreides", "Muad'Dib", "Usul" are one person). "name" is the form used most often in the dialogue tags; put the others in "aliases" (include every candidate name that refers to this person).
- Drop candidates that are not people who speak (places, objects, "Chapter", exclamations). Animals and creatures that talk are characters.
- gender/age: from the text and what you know of the book; "neutral" only if truly unknown.
- traits: at most 8 words about how they sound and behave (e.g. "calm, commanding, measured", "nervous teenage boy").
- voice: pick from the voice list the best fit for each character (gender, age, accent, personality). Main characters get distinct voices; minor ones may share. The narrator is not a character.
- If "series_cast" lists characters from other books of the same author or series, keep the same person with the same name and the same voice.
- Answer with the JSON only.`;

export async function POST(req: Request) {
  const access = await getAccess(req);
  if (!access.ok) return denied(access);
  if (!aiProvider()) return Response.json({ error: "No AI key on the server" }, { status: 501 });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.candidates)) return Response.json({ error: "Nothing to cast" }, { status: 400 });

  const candidates = (body.candidates as { name: string; lines?: number; gender?: string; samples?: string[] }[])
    .slice(0, 40)
    .map((c) => ({ name: String(c.name).slice(0, 60), lines: c.lines ?? 0, guess: c.gender ?? "", samples: (c.samples ?? []).slice(0, 3).map((x) => String(x).slice(0, 200)) }));
  const voices = STUDIO_VOICES.filter((v) => !v.fun).map((v) => `${v.id}: ${v.name} (${v.gender})`).join("\n");
  const user = [
    `Book: "${String(body.title ?? "").slice(0, 120)}"${body.author ? ` by ${String(body.author).slice(0, 80)}` : ""}`,
    `Voices:\n${voices}`,
    body.series?.length ? `series_cast (keep these): ${JSON.stringify(body.series.slice(0, 40))}` : "",
    `Candidates found by the program: ${JSON.stringify(candidates)}`,
    `Opening of the book:\n${String(body.sample ?? "").slice(0, 7000)}`,
  ].filter(Boolean).join("\n\n");

  try {
    const raw = (await askJson(SYSTEM, user, 6000)) as { characters?: unknown[] };
    const ids = new Set(STUDIO_VOICES.map((v) => v.id));
    const characters: Character[] = (Array.isArray(raw?.characters) ? raw.characters : [])
      .filter((c: any) => c && typeof c.name === "string" && c.name.trim())
      .slice(0, 40)
      .map((c: any) => ({
        name: String(c.name).trim().slice(0, 60),
        aliases: Array.isArray(c.aliases) ? c.aliases.filter((a: unknown) => typeof a === "string" && a.trim()).map((a: string) => a.trim().slice(0, 60)).slice(0, 10) : [],
        gender: ["male", "female"].includes(c.gender) ? c.gender : "neutral",
        age: ["child", "young", "elderly"].includes(c.age) ? c.age : "adult",
        traits: typeof c.traits === "string" ? c.traits.slice(0, 80) : undefined,
        importance: ["main", "supporting", "minor"].includes(c.importance) ? c.importance : "supporting",
        voice: ids.has(c.voice) ? c.voice : undefined,
      }));
    return Response.json({ characters, by: aiProvider() });
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError(String(e));
    return Response.json({ error: err.message }, { status: err.status });
  }
}
