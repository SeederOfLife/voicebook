// Fallback analysis used when no ANTHROPIC_API_KEY is configured (or the AI call fails).
// It can't identify who is speaking, but it separates dialogue from narration,
// alternates two dialogue voices and guesses emotion from punctuation.
import { attribution, matchCharacter, QUOTES } from "./cast-scan";
import type { Ambience, Analysis, Character, Emotion, Genre, Mood, RawSegment } from "./types";

const SCENE_WORDS: [Ambience, RegExp][] = [
  ["storm", /\b(storm|thunder|lightning|tempest|bouře|orage|tonnerre)\b/gi],
  ["rain", /\b(rain|raining|drizzle|déšť|pluie)\b/gi],
  ["sea", /\b(sea|ocean|waves?|shore|beach|harbou?r|ship|moře|mer|vagues?)\b/gi],
  ["fire", /\b(fire|fireplace|hearth|campfire|flames?|oheň|feu)\b/gi],
  ["forest", /\b(forest|woods|trees|les|forêt|bois)\b/gi],
  ["night", /\b(night|moon|stars|midnight|noc|nuit)\b/gi],
  ["city", /\b(city|street|traffic|cars?|town|město|ville|rue)\b/gi],
  ["wind", /\b(wind|gale|breeze|vítr|vent)\b/gi],
  ["cave", /\b(cave|cavern|tunnel|dungeon|jeskyně|grotte)\b/gi],
];

function guessScene(text: string, genre: Genre): { ambience: Ambience; music: Mood } {
  if (genre !== "novel") return { ambience: "none", music: "none" };
  let best: Ambience = "none";
  let n = 1;
  for (const [amb, re] of SCENE_WORDS) {
    const c = (text.match(re) ?? []).length;
    if (c > n) {
      best = amb;
      n = c;
    }
  }
  const tense = (text.match(/\b(afraid|fear|dark|scream|blood|danger|whisper|trembl)\w*/gi) ?? []).length;
  return { ambience: best, music: tense >= 2 ? "mysterious" : "calm" };
}

// Double quotes, guillemets, and single quotes ('…' / ‘…’) that aren't apostrophes.
const QUOTE_RE = new RegExp(`(${QUOTES})`, "gu");
const isQuote = (s: string) => /^\s*[“"«„‘']/.test(s) && /[”"»“’']\s*$/.test(s);
const stripQuotes = (s: string) => s.trim().replace(/^[“"«„‘']\s*/, "").replace(/\s*[”"»“’']$/, "");

function guessEmotion(s: string): Emotion {
  if (/!{1}.*!|!{2,}/.test(s)) return "excited";
  if (/!/.test(s)) return "surprised";
  if (/\?/.test(s)) return "curious";
  if (/…|\.\.\./.test(s)) return "mysterious";
  return "neutral";
}

export function guessLanguage(text: string): string {
  const sample = ` ${text.slice(0, 4000).toLowerCase()} `;
  const score = (words: string[]) =>
    words.reduce((n, w) => n + (sample.split(` ${w} `).length - 1), 0);
  const langs: Record<string, string[]> = {
    en: ["the", "and", "of", "to", "is", "you", "that"],
    fr: ["le", "la", "les", "et", "des", "est", "une", "que"],
    cs: ["a", "je", "se", "na", "že", "to", "jsem", "není"],
    de: ["der", "die", "und", "das", "ist", "nicht", "ich"],
    es: ["el", "la", "que", "y", "los", "es", "una"],
    it: ["il", "che", "di", "e", "la", "non", "una"],
    pt: ["o", "que", "de", "não", "uma", "os", "é"],
  };
  let best = "";
  let bestScore = 2;
  for (const [lang, words] of Object.entries(langs)) {
    const s = score(words);
    if (s > bestScore) {
      best = lang;
      bestScore = s;
    }
  }
  return best;
}

function detectGenre(text: string, quoteCount: number): Genre {
  // Lots of dialogue: a story, even if a word like "select" appears.
  if (quoteCount >= 6) return "novel";
  const steps = (text.match(/^\s*(\d+[.)]|step\s+\d+|[-•*▪])\s+/gim) ?? []).length;
  const guideWords = (text.match(/\b(install|click|select|configure|ingredients|how to)\b/gi) ?? []).length;
  if (steps >= 3 || guideWords >= 2) return "guide";
  if (quoteCount >= 2) return "novel";
  return "other";
}

export function heuristicAnalyze(text: string, known: Character[] = []): Analysis {
  // Lines of a paragraph are joined first: a quote often runs over a line break.
  const quoteCount = (text.replace(/([^\n])\n(?=[^\n])/g, "$1 ").match(QUOTE_RE) ?? []).length;
  const genre = detectGenre(text, quoteCount);
  const fiction = genre === "novel";
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

  const segments: RawSegment[] = [];
  const cast = known.filter((c) => c.name !== "Narrator" && !/^Speaker [AB]$/.test(c.name));
  let turn = 0;
  let recent: string[] = []; // who spoke last, most recent first
  for (const p of paras) {
    const parts = p.split(QUOTE_RE).filter((s) => s.trim());
    let speaker = "";
    if (fiction && cast.length && parts.some(isQuote)) speaker = whoSpeaks(p, cast, recent);
    if (!speaker) speaker = turn++ % 2 ? "Speaker B" : "Speaker A";
    if (fiction && parts.some(isQuote)) recent = [speaker, ...recent.filter((n) => n !== speaker)].slice(0, 4);
    for (const part of parts) {
      if (fiction && isQuote(part)) {
        segments.push({ speaker, text: stripQuotes(part), emotion: guessEmotion(part) });
      } else {
        segments.push({
          speaker: "Narrator",
          text: part.trim(),
          emotion: fiction ? "neutral" : "calm",
        });
      }
    }
  }

  const used = new Set(segments.map((s) => s.speaker));
  const characters: Character[] = [];
  if (used.has("Speaker A") && !known.some((c) => c.name === "Speaker A"))
    characters.push({ name: "Speaker A", gender: "male", age: "adult" });
  if (used.has("Speaker B") && !known.some((c) => c.name === "Speaker B"))
    characters.push({ name: "Speaker B", gender: "female", age: "adult" });

  return { genre, language: guessLanguage(text), narrationStyle: "", characters, segments, scene: guessScene(text, genre) };
}

/** Which known character speaks the dialogue of this paragraph ("" if it can't be told). */
function whoSpeaks(p: string, cast: Character[], recent: string[]): string {
  for (const q of p.matchAll(QUOTE_RE)) {
    const who = attribution(p, q.index!, q.index! + q[0].length);
    if (!who) continue;
    if (who === "he" || who === "she") {
      const g = who === "he" ? "male" : "female";
      const byPronoun = recent.find((n) => cast.find((c) => c.name === n)?.gender === g);
      if (byPronoun) return byPronoun;
      const mentioned = cast.find((c) => c.gender === g && p.includes(c.name));
      if (mentioned) return mentioned.name;
      continue;
    }
    const c = matchCharacter(who, cast);
    if (c) return c.name;
  }
  // A character named in the narration of the paragraph ("Tom shook his head. “No.”").
  const narration = p.replace(QUOTE_RE, " ");
  let first: { name: string; at: number } | null = null;
  for (const c of cast) {
    const at = narration.search(new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
    if (at >= 0 && (!first || at < first.at)) first = { name: c.name, at };
  }
  if (first) return first.name;
  // A conversation: speakers take turns.
  if (recent.length >= 2) return recent[1];
  return "";
}
