import type { Character, Emotion, Gender, VoiceOption } from "./types";

export const OPENAI_VOICES: VoiceOption[] = [
  { id: "cedar", name: "Cedar", gender: "male" },
  { id: "marin", name: "Marin", gender: "female" },
  { id: "fable", name: "Fable", gender: "male" },
  { id: "sage", name: "Sage", gender: "female" },
  { id: "ballad", name: "Ballad", gender: "male" },
  { id: "coral", name: "Coral", gender: "female" },
  { id: "ash", name: "Ash", gender: "male" },
  { id: "nova", name: "Nova", gender: "female" },
  { id: "onyx", name: "Onyx", gender: "male" },
  { id: "shimmer", name: "Shimmer", gender: "female" },
  { id: "echo", name: "Echo", gender: "male" },
  { id: "verse", name: "Verse", gender: "male" },
  { id: "alloy", name: "Alloy", gender: "neutral" },
];

// The studio voice (Kokoro). Only its best-rated English voices are offered; the
// first is the default reading voice.
export const STUDIO_VOICES: VoiceOption[] = [
  { id: "af_heart", name: "Heart · warm, American", gender: "female", useCase: "narration" },
  { id: "af_bella", name: "Bella · lively, American", gender: "female" },
  { id: "bf_emma", name: "Emma · British", gender: "female" },
  { id: "am_michael", name: "Michael · American", gender: "male" },
  { id: "bm_george", name: "George · British", gender: "male" },
  { id: "am_fenrir", name: "Fenrir · deep, American", gender: "male" },
  { id: "af_nicole", name: "Nicole · soft, close", gender: "female" },
  { id: "bm_fable", name: "Fable · British storyteller", gender: "male" },
  { id: "am_puck", name: "Puck · bright, American", gender: "male" },
  { id: "af_sarah", name: "Sarah · American", gender: "female" },
  { id: "af_aoede", name: "Aoede · American", gender: "female" },
  { id: "bf_isabella", name: "Isabella · British", gender: "female" },
];

// Used only if the ElevenLabs voice list can't be fetched.
export const ELEVENLABS_FALLBACK_VOICES: VoiceOption[] = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George", gender: "male", useCase: "narration" },
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", gender: "female" },
  { id: "nPczCjzI2devNBz1zQrb", name: "Brian", gender: "male", useCase: "narration" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", gender: "female" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam", gender: "male" },
  { id: "XB0fDUnXU5powFXDhCwa", name: "Charlotte", gender: "female" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Charlie", gender: "male" },
  { id: "pFZP5JQG7iQjIQuC4Bku", name: "Lily", gender: "female" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", gender: "male" },
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", gender: "female" },
];

const NARRATOR_PREFS: Record<string, string[]> = {
  novel: ["fable", "cedar", "ballad", "sage"],
  play: ["fable", "cedar", "ballad"],
  children_story: ["coral", "fable", "shimmer"],
  guide: ["sage", "marin", "alloy", "nova"],
  textbook: ["sage", "marin", "alloy"],
  news: ["onyx", "marin", "alloy"],
  poetry: ["ballad", "shimmer", "sage"],
  essay: ["cedar", "sage"],
  other: ["cedar", "marin", "alloy"],
};

export const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** Give the narrator and every character a voice, keeping existing choices. */
export function castVoices(
  characters: Character[],
  voices: VoiceOption[],
  genre: string,
  existing: Record<string, string>,
): Record<string, string> {
  const result = { ...existing };
  if (!voices.length) return result;
  const valid = new Set(voices.map((v) => v.id));
  for (const k of Object.keys(result)) if (!valid.has(result[k])) delete result[k];
  const used = new Set(Object.values(result));

  if (!result.Narrator) {
    const prefs = NARRATOR_PREFS[genre] ?? NARRATOR_PREFS.other;
    const pick =
      prefs.map((id) => voices.find((v) => v.id === id)).find(Boolean) ??
      voices.find((v) => /narrat|audiobook|story/i.test(v.useCase ?? "")) ??
      voices[0];
    result.Narrator = pick.id;
    used.add(pick.id);
  }

  for (const ch of characters) {
    if (ch.name === "Narrator" || result[ch.name]) continue;
    const fits = (g: Gender) => ch.gender === "neutral" || g === ch.gender || g === "neutral";
    const pool = voices.filter((v) => fits(v.gender) && v.id !== result.Narrator);
    const list = pool.length ? pool : voices;
    const pick = list.find((v) => !used.has(v.id)) ?? list[hash(ch.name) % list.length];
    result[ch.name] = pick.id;
    used.add(pick.id);
  }
  return result;
}

// ---------- Browser (free) voices ----------

const FEMALE =
  /female|woman|samantha|victoria|karen|moira|tessa|zira|susan|serena|fiona|veena|amelie|amélie|audrey|anna|alice|ellen|helena|hortense|paulina|monica|zuzana|ioana|laura|sara|nora|joana|luciana|milena|kyoko|ting|yuna|mei|lekha|catherine|allison|ava|kate|martha|nicky|aria|jenny|libby|sonia|denise|elsa|katja|hedda|heather|hazel|linda|marie|julie|vlasta|iveta/i;
const MALE =
  /\bmale\b|\bman\b|daniel|alex|fred|tom|oliver|thomas|jorge|diego|juan|luca|yuri|xander|rishi|aaron|arthur|gordon|reed|ralph|guy|ryan|david|mark|george|james|henri|paul|stefan|jakub|antonin|antonín|nicolas|eddy|grandpa|rocko/i;

// Joke / robotic voices shipped with macOS & iOS — never use them for reading.
const NOVELTY =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|princess|junior|ralph|kathy|fred|grandma|grandpa|rocko|shelley|flo|reed|sandy|eddy)\b/i;

/** Higher = more natural. Neural / "Natural" / "Premium" / "Enhanced" voices sound far better. */
export function voiceQuality(v: SpeechSynthesisVoice): number {
  const n = v.name;
  if (NOVELTY.test(n) || /espeak|eloquence|compact/i.test(n + v.voiceURI)) return -100;
  let q = 0;
  if (/natural|neural/i.test(n)) q += 60; // Microsoft Edge "… Online (Natural)"
  if (/premium/i.test(n)) q += 70; // Apple premium (downloaded): the best on iPhone/iPad/Mac
  if (/enhanced|siri/i.test(n)) q += 45; // Apple enhanced / Siri
  if (/online/i.test(n)) q += 20;
  if (/^google/i.test(n)) q += 30; // Chrome's Google voices
  if (/microsoft/i.test(n) && !/natural|online/i.test(n)) q -= 10; // old SAPI voices
  if (/samantha|daniel|karen|moira|serena|arthur|martha|amélie|amelie|thomas|anna|zuzana/i.test(n)) q += 8;
  if (v.default) q += 2;
  return q;
}

export function browserVoiceOptions(): VoiceOption[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis
    .getVoices()
    .map((v) => ({ v, q: voiceQuality(v) }))
    .sort((a, b) => b.q - a.q)
    .map(({ v, q }) => ({
      fun: q <= -100,
      id: v.voiceURI,
      name: `${q >= 40 ? "★ " : ""}${v.name.replace(/\s*\(.*?\)\s*/g, " ").replace(/Microsoft |Google /, "").trim()} (${v.lang})`,
      lang: v.lang,
      gender: /female/i.test(v.name) ? "female" : MALE.test(v.name) ? "male" : FEMALE.test(v.name) ? "female" : "neutral",
    }));
}

const EMOTION_PROSODY: Record<Emotion, { rate: number; pitch: number; volume: number }> = {
  neutral: { rate: 1, pitch: 0, volume: 1 },
  happy: { rate: 1.07, pitch: 0.12, volume: 1 },
  sad: { rate: 0.85, pitch: -0.15, volume: 0.85 },
  angry: { rate: 1.1, pitch: 0.05, volume: 1 },
  fearful: { rate: 1.12, pitch: 0.15, volume: 0.9 },
  excited: { rate: 1.15, pitch: 0.2, volume: 1 },
  whisper: { rate: 0.9, pitch: -0.05, volume: 0.45 },
  tender: { rate: 0.9, pitch: 0.05, volume: 0.85 },
  sarcastic: { rate: 0.95, pitch: 0.08, volume: 1 },
  surprised: { rate: 1.05, pitch: 0.2, volume: 1 },
  serious: { rate: 0.95, pitch: -0.08, volume: 1 },
  calm: { rate: 0.93, pitch: -0.03, volume: 0.95 },
  curious: { rate: 1, pitch: 0.1, volume: 1 },
  mysterious: { rate: 0.85, pitch: -0.1, volume: 0.85 },
};

/** Pitch/rate so characters sound different even with a single system voice. */
export function browserProsody(emotion: Emotion, character?: Character, intensity = 1, expressiveness = 1) {
  let pitch = 1;
  let rate = 1;
  if (character) {
    if (character.gender === "male") pitch = 0.82;
    if (character.gender === "female") pitch = 1.18;
    if (character.age === "child") {
      pitch += 0.3;
      rate = 1.05;
    }
    if (character.age === "elderly") {
      pitch -= 0.08;
      rate = 0.88;
    }
    pitch += ((hash(character.name) % 9) - 4) * 0.025; // small per-character offset
  }
  const e = EMOTION_PROSODY[emotion] ?? EMOTION_PROSODY.neutral;
  const k = [0, 0.7, 1, 1.45][Math.min(3, Math.max(1, intensity))] * expressiveness;
  const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
  return {
    pitch: clamp(pitch + e.pitch * k, 0.1, 2),
    rate: clamp(rate * (1 + (e.rate - 1) * k), 0.5, 2),
    volume: clamp(1 - (1 - e.volume) * k, 0.2, 1),
  };
}
