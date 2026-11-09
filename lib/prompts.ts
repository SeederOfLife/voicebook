import type { Emotion, TTSRequest } from "./types";
import { AMBIENCES, EMOTIONS, GENRES, MOODS } from "./types";

export const ANALYZE_SYSTEM = `You are the casting director and script editor of an audiobook studio.
You receive one passage extracted from a document (PDF/EPUB/text). It may contain extraction noise: page numbers, running headers/footers, words broken by hyphenation, lines broken mid-sentence.

Return ONLY a JSON object (no markdown, no commentary) with exactly this shape:
{
  "genre": one of ${GENRES.map((g) => `"${g}"`).join(", ")},
  "language": ISO 639-1 code of the passage (e.g. "en", "fr", "cs"),
  "narrationStyle": one sentence directing the narrator for this kind of text,
  "characters": [{"name": string, "gender": "male"|"female"|"neutral", "age": "child"|"young"|"adult"|"elderly", "traits": "≤12 words about their voice and personality", "accent": string}],
  "scene": {"ambience": one of ${AMBIENCES.map((a) => `"${a}"`).join(", ")}, "music": one of ${MOODS.map((m) => `"${m}"`).join(", ")}},
  "segments": [{"speaker": string, "text": string, "emotion": string, "intensity": 1|2|3, "delivery": string, "tags": string[], "sfx": string}]
}

Rules for segments:
1. Reproduce the passage IN ORDER and VERBATIM. Never summarise, paraphrase, translate or skip prose. You may only drop pure layout noise (page numbers, repeated running headers) and repair hyphenated or broken lines.
2. Start a new segment whenever the speaker or the emotion changes.
3. Spoken dialogue belongs to the character who says it (text without the surrounding quotation marks). Narration around it ("she said", descriptions) belongs to "Narrator".
4. Work out who speaks from dialogue tags, names, and alternating turns. Reuse names from knownCharacters EXACTLY when it is the same person. If a speaker is unnamed, use a short descriptive name ("Old man", "Guard").
5. Non-fiction (guide, textbook, news, essay): everything is "Narrator" unless someone is quoted; keep emotions mostly neutral/calm/serious/curious. Put headings in their own segment with delivery "heading: announce clearly, short pause after". Numbered steps: delivery like "clear, deliberate, pause after the step".
6. emotion must be one of: ${EMOTIONS.join(", ")}.
7. intensity: how strongly the emotion shows — 1 subtle (most narration), 2 clear, 3 intense (screaming, sobbing, terror, ecstatic joy). Be honest: most lines are 1.
   tags: 0–3 short performance cues an actor would mark in the script, in English, chosen from things like: whispers, softly, shouts, laughs, chuckles, giggles, sighs, gasps, sobbing, sniffles, clears throat, nervous, hesitant, sarcastic, cheerful, cold, menacing, warm, excited, exhausted, breathless, pause, dramatic pause, slowly, quickly, mischievously, curious, crying, angry, frustrated, resigned, awed, relieved. Empty array when nothing special. For non-fiction usually [].
   delivery: up to 12 words of acting direction (pace, volume, attitude, sounds), e.g. "trembling, holding back tears", "shouting across the courtyard", "with a soft laugh". Empty string if nothing special.
8. characters: every character who speaks in this passage (include known ones who speak here). "accent": only if the text makes it clear (nationality, region, how they talk), e.g. "French", "Scottish"; otherwise "".
9. scene: the background soundscape that fits where this passage takes place ("none" if unclear or non-fiction) and the background music mood. Guides, textbooks and news: ambience "none", music "none" or "calm".
10. sfx: a short English description of a distinct sound that literally happens at that moment in the story ("thunder crack", "door creaks open", "glass shatters", "horse galloping away"). Leave "" almost always: at most one sfx per ~8 segments, only for clear, dramatic sounds, never for non-fiction.`;

export function analyzeUserMessage(
  text: string,
  knownCharacters: unknown,
  context: { genre?: string; narrationStyle?: string } | null,
) {
  return `knownCharacters: ${JSON.stringify(knownCharacters ?? [])}
${context?.genre ? `The document so far was classified as "${context.genre}". Keep consistent unless clearly wrong.` : "This is the beginning of the document."}

<passage>
${text}
</passage>`;
}

const GENRE_STYLE: Record<string, string> = {
  novel: "Immersive audiobook storytelling. Vary pace with the tension of the scene; let pauses breathe.",
  children_story: "Warm, playful, animated storyteller for children. Slow, clear and full of wonder.",
  guide: "Clear, friendly instructor. Steady pace, emphasise key terms and step numbers, short pauses between steps.",
  textbook: "Patient teacher. Clear articulation, emphasise definitions and key ideas, measured pace.",
  news: "Professional news presenter. Crisp, neutral, confident.",
  poetry: "Read as poetry: respect line breaks, rhythmic and contemplative, gentle pauses.",
  play: "Theatrical and dramatic, as in a radio play.",
  essay: "Thoughtful, articulate reading that follows the argument, with natural emphasis.",
  other: "Natural, engaging narration.",
};

const EMOTION_DIRECTION: Record<Emotion, string> = {
  neutral: "natural",
  happy: "happy, smiling voice",
  sad: "sad, heavy, slower, voice slightly breaking",
  angry: "angry, tense, forceful",
  fearful: "afraid, nervous, breathy and quick",
  excited: "excited, energetic, faster",
  whisper: "whispering, very soft and close",
  tender: "tender, gentle and warm",
  sarcastic: "sarcastic, dry, ironic emphasis",
  surprised: "surprised, rising intonation",
  serious: "serious and grave",
  calm: "calm and soothing",
  curious: "curious, inquisitive",
  mysterious: "mysterious, hushed and suspenseful",
};

const INTENSITY_WORD = ["", "subtly", "clearly", "intensely"];
const AGE_VOICE: Record<string, string> = {
  child: "a young child's light, high, energetic voice",
  young: "a youthful voice",
  adult: "a mature adult voice",
  elderly: "an older voice, slightly slower and textured with age",
};

/** OpenAI gpt-4o-mini-tts follows structured "director's notes" best. */
export function openAIInstructions(r: TTSRequest): string {
  const narrator = r.speaker === "Narrator" || !r.character;
  const genre = r.genre ?? "other";
  const nonFiction = ["guide", "textbook", "news", "essay"].includes(genre);
  const intensity = Math.min(3, Math.max(1, r.intensity ?? 1));
  const lines: string[] = [];

  if (narrator) {
    lines.push(`Voice Affect: ${GENRE_STYLE[genre] ?? GENRE_STYLE.other}${r.narrationStyle ? ` ${r.narrationStyle}` : ""}`);
    lines.push(
      nonFiction
        ? "Tone: warm, clear and confident, like a favourite teacher or presenter. Never robotic or monotone."
        : "Tone: a professional audiobook narrator — intimate, engaged, painting the scene. Never monotone.",
    );
  } else {
    const c = r.character!;
    lines.push(
      `Character: you are an actor playing ${c.name} in a full-cast audiobook — ${AGE_VOICE[c.age] ?? AGE_VOICE.adult}${c.gender === "neutral" ? "" : `, ${c.gender}`}.${c.traits ? ` Personality: ${c.traits}.` : ""}`,
    );
    lines.push("Tone: fully in character, natural and believable, as in a high-end radio drama. Never read it like a narrator.");
  }

  const emo = EMOTION_DIRECTION[r.emotion] ?? "natural";
  lines.push(`Emotion: ${r.emotion === "neutral" ? "natural and conversational" : `${INTENSITY_WORD[intensity]} ${emo}`}.`);
  if (r.delivery) lines.push(`Delivery: ${r.delivery}.`);
  if (r.tags?.length) lines.push(`Performance cues: ${r.tags.join(", ")}. Perform these (e.g. an actual sigh or laugh), don't say them.`);
  lines.push(
    intensity >= 3
      ? "Pacing: let the emotion drive the rhythm — break up the line, use breath and real pauses."
      : nonFiction
        ? "Pacing: steady and unhurried, with short pauses at commas and clear pauses between ideas."
        : "Pacing: natural, varied, with pauses where a good reader would breathe.",
  );
  lines.push("Pronunciation: crisp and natural; stress the important words so the meaning is obvious.");
  if (r.accent) lines.push(`Accent: a natural, consistent ${r.accent} accent.`);
  if (r.language) lines.push(`Language: speak in the language of the text (${r.language})${r.accent ? "" : " with a native accent"}.`);
  return lines.join("\n");
}

/** Eleven v3 stability: 0 = creative (most expressive), 0.5 = natural, 1 = robust (steady). */
export function elevenStability(r: TTSRequest): number {
  const nonFiction = ["guide", "textbook", "news", "essay"].includes(r.genre ?? "");
  if ((r.intensity ?? 1) >= 3) return 0;
  if (nonFiction && r.speaker === "Narrator") return 1;
  return 0.5;
}

const ELEVEN_TAG: Partial<Record<Emotion, string>> = {
  happy: "happily",
  sad: "sad",
  angry: "angry",
  fearful: "nervous",
  excited: "excited",
  whisper: "whispers",
  tender: "softly",
  sarcastic: "sarcastic",
  surprised: "surprised",
  serious: "seriously",
  calm: "calmly",
  curious: "curious",
  mysterious: "mysteriously",
};

/** Eleven v3 reads [audio tags] as performance directions. */
export function elevenText(r: TTSRequest, useTags: boolean): string {
  if (!useTags) return r.text;
  const tags: string[] = (r.tags ?? []).map((t) => t.replace(/[\[\]]/g, "").trim().toLowerCase()).filter(Boolean).slice(0, 3);
  const t = ELEVEN_TAG[r.emotion];
  if (t && !tags.length && (r.intensity ?? 1) >= 1 && r.emotion !== "neutral") tags.push(t);
  const d = (r.delivery ?? "").toLowerCase();
  if (/shout|yell|scream/.test(d)) tags.push("shouts");
  if (/laugh|chuckl/.test(d)) tags.push("laughs");
  if (/sigh/.test(d) && !tags.includes("sighs")) tags.push("sighs");
  if (/cry|crying|tears|sob/.test(d) && r.emotion !== "sad") tags.push("crying");
  if (/whisper/.test(d) && !tags.includes("whispers")) tags.push("whispers");
  if (r.accent) tags.unshift(`${r.accent} accent`);
  return tags.length ? `${tags.map((x) => `[${x}]`).join(" ")} ${r.text}` : r.text;
}
