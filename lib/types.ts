export const EMOTIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "fearful",
  "excited",
  "whisper",
  "tender",
  "sarcastic",
  "surprised",
  "serious",
  "calm",
  "curious",
  "mysterious",
] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const GENRES = [
  "novel",
  "children_story",
  "guide",
  "textbook",
  "news",
  "poetry",
  "play",
  "essay",
  "other",
] as const;
export type Genre = (typeof GENRES)[number];

export type Gender = "male" | "female" | "neutral";
export type Age = "child" | "young" | "adult" | "elderly";

export const AMBIENCES = ["none", "rain", "storm", "wind", "sea", "fire", "forest", "night", "city", "cave"] as const;
export type Ambience = (typeof AMBIENCES)[number];
export const MOODS = ["none", "calm", "warm", "happy", "playful", "sad", "tense", "mysterious", "epic"] as const;
export type Mood = (typeof MOODS)[number];
export const ACCENTS = [
  "", "American", "British", "Irish", "Scottish", "Australian", "Southern US", "Indian",
  "French", "German", "Italian", "Spanish", "Russian", "Czech", "Polish", "Japanese",
] as const;

export interface Character {
  name: string;
  gender: Gender;
  age: Age;
  traits?: string;
  accent?: string;
}

export interface Scene {
  ambience: Ambience;
  music: Mood;
}

export interface Chapter {
  title: string;
  chunk: number;
}

export type Plan = "free" | "premium";

export interface RawSegment {
  speaker: string;
  text: string;
  emotion: Emotion;
  delivery?: string;
  sfx?: string;
}

export interface Segment extends RawSegment {
  id: string;
  chunk: number;
}

export interface Analysis {
  genre: Genre;
  language: string;
  narrationStyle: string;
  characters: Character[];
  segments: RawSegment[];
  scene?: Scene;
}

export type Provider = "elevenlabs" | "openai" | "browser";

export interface VoiceOption {
  id: string;
  name: string;
  gender: Gender;
  lang?: string;
  useCase?: string;
}

export interface AppConfig {
  providers: { elevenlabs: boolean; openai: boolean; anthropic: boolean };
  passwordRequired: boolean;
  authorized: boolean;
  /** "open" = personal mode (no accounts, everything unlocked); "accounts" = Supabase sign-in + plans */
  mode: "open" | "accounts";
  plan: Plan;
  user: { email: string } | null;
  supabase: { url: string; anonKey: string } | null;
  billing: boolean;
  voices: { openai: VoiceOption[]; elevenlabs: VoiceOption[] };
}

export interface TTSRequest {
  provider: Provider;
  voice: string;
  text: string;
  emotion: Emotion;
  delivery?: string;
  speaker: string;
  character?: Character;
  genre?: string;
  narrationStyle?: string;
  language?: string;
  accent?: string;
}
