// Sound effects made inside the app (no files, no server): onomatopoeia written in the book
// (*SNIKT*, *BOOM*, KRAK!, *screech*) play a sound instead of being read out, and game-style
// [system messages] get a short notification chime and their own voice.

export const FX_SPEAKER = "FX";
export const SYSTEM_SPEAKER = "System";

export type FxKind =
  | "blade" | "impact" | "boom" | "gunshot" | "crash" | "clang" | "screech"
  | "whoosh" | "splash" | "knock" | "zap" | "roar" | "ding" | "chime";

const WORDS: Record<string, FxKind> = {};
const add = (kind: FxKind, list: string) => list.split(" ").forEach((w) => (WORDS[w] = kind));
add("blade", "snikt snickt shing schwing shwing shink shiing slash slice swish shhk shk shunk stab skewer schlick shlick shik tchak");
add("impact", "thud thump bam wham whump pow punch smack whack bonk thwack slam bash thunk dunk wump fwump oof thwump whomp");
add("boom", "boom kaboom kaboomm bwoom whoom vroom blammo kablam kablooey booom");
add("gunshot", "bang blam pew ratatat ratatatat budda pop crack krak kchak");
add("crash", "crash smash shatter crunch clatter tinkle kerrash krash kssh crsh");
add("clang", "clang clank clink ting tink gong dong klang kling klong");
add("screech", "screech skree scree shriek squeal skreech eek eee screee kreee");
add("whoosh", "whoosh swoosh woosh fwoosh whish whoosh zoom fwip whip zip zwoop");
add("splash", "splash splat splosh plop squelch drip splurt sploosh");
add("knock", "knock tap tok clack click clop thok tock tick knok");
add("zap", "zap zzap bzzt bzz kzzt crackle fizz sizzle zzt bzt zzzt");
add("roar", "roar rawr grr grrr rumble growl raaa rooar");
add("ding", "ding ping beep bing chime boop dong");

const normal = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "");
const squeeze = (w: string, n: number) => w.replace(/(.)\1+/g, (_m, c: string) => c.repeat(n));

/** The kind of sound a word stands for, or null when it is an ordinary word. */
export function classifyFx(word: string): FxKind | null {
  const w = normal(word);
  if (w.length < 2 || w.length > 18) return null;
  for (const v of [w, squeeze(w, 2), squeeze(w, 1)]) if (WORDS[v]) return WORDS[v];
  if (/^(ka)?b+o{2,}m+$/.test(w)) return "boom";
  if (/^b*z{2,}t*$/.test(w) || /^k*z{2,}t*$/.test(w)) return "zap";
  if (/^e{3,}k*$/.test(w) || /^(s?k|s)re{2,}/.test(w)) return "screech";
  if (/^g?r{3,}$/.test(w) || /^gr{2,}a*h*$/.test(w)) return "roar";
  if (/^(w|f)h?o{2,}s+h*$/.test(w)) return "whoosh";
  if (/^sh?n?i+k+t*$/.test(w)) return "blade";
  return null;
}

export type Piece = { kind: "text"; text: string } | { kind: "fx"; text: string; fx: FxKind } | { kind: "system"; text: string };

const ASTERISK = /\*{1,2}(?=\S)([^*\n]{1,40}?)(?<=\S)\*{1,2}/y;
const BRACKET = /\[([^[\]\n]{2,400})\]/y;
const CAPS = /\b([A-Z][A-Z-]{2,17})(!*)(?![a-z])/y;

/**
 * Cut a line into narration, sound effects and system messages. Stray asterisks are
 * dropped so they are never read out as "asterisk".
 */
export function splitEffects(text: string): Piece[] {
  if (!/[*[]|[A-Z]{3}/.test(text)) return [{ kind: "text", text }];
  const out: Piece[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.replace(/\*+/g, "").replace(/\s+/g, " ").trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ kind: "text", text: t });
    else if (t && out.length && out[out.length - 1].kind === "text") (out[out.length - 1] as { text: string }).text += t;
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "*") {
      ASTERISK.lastIndex = i;
      const m = ASTERISK.exec(text);
      if (m) {
        const inner = m[1].trim();
        const kind = classifyFx(inner);
        if (kind) {
          flush();
          out.push({ kind: "fx", text: inner, fx: kind });
        } else buf += inner; // *emphasis*: read the word, not the asterisks
        i += m[0].length;
        continue;
      }
      i++; // a lone asterisk
      continue;
    }
    if (c === "[") {
      BRACKET.lastIndex = i;
      const m = BRACKET.exec(text);
      if (m && /[\p{L}\p{N}]/u.test(m[1])) {
        flush();
        out.push({ kind: "system", text: m[1].trim() });
        i += m[0].length;
        continue;
      }
    }
    if (c >= "A" && c <= "Z" && (i === 0 || !/[\p{L}]/u.test(text[i - 1]))) {
      CAPS.lastIndex = i;
      const m = CAPS.exec(text);
      if (m) {
        const kind = classifyFx(m[1]);
        if (kind) {
          flush();
          out.push({ kind: "fx", text: m[1] + m[2], fx: kind });
          i += m[0].length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out.length ? out : [{ kind: "text", text }];
}

// ---------- synthesis ----------

const RATE = 22050;

/** Small deterministic random numbers, so a word always makes the same sound. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

function seedOf(word: string) {
  let h = 2166136261;
  for (const ch of word.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** One-pole low-pass / high-pass helpers (cheap, good enough for effects). */
function lowpass(x: Float32Array, hz: (i: number) => number) {
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp((-2 * Math.PI * hz(i)) / RATE);
    y += a * (x[i] - y);
    x[i] = y;
  }
}
function highpass(x: Float32Array, hz: number) {
  const a = 1 - Math.exp((-2 * Math.PI * hz) / RATE);
  let lp = 0;
  for (let i = 0; i < x.length; i++) {
    lp += a * (x[i] - lp);
    x[i] = x[i] - lp;
  }
}
/** Resonant band-pass (biquad) with a moving centre frequency. */
function bandpass(x: Float32Array, hz: (i: number) => number, q: number) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const w = (2 * Math.PI * Math.min(hz(i), RATE * 0.45)) / RATE;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
    const v = x[i];
    const o = b0 * v + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o;
    x[i] = o;
  }
}

const env = (t: number, attack: number, decay: number) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

function render(kind: FxKind, seed: number): Float32Array {
  const r = rng(seed);
  const v = 1 + r() * 0.08; // a little variation per word
  const dur: Record<FxKind, number> = {
    blade: 0.7, impact: 0.45, boom: 1.6, gunshot: 0.7, crash: 1.0, clang: 1.2, screech: 0.85,
    whoosh: 0.6, splash: 0.7, knock: 0.55, zap: 0.6, roar: 1.1, ding: 0.8, chime: 0.75,
  };
  const n = Math.round(dur[kind] * RATE);
  const out = new Float32Array(n);
  const noise = () => r();
  const ring = (freqs: number[], decay: number, gain: number, start = 0) => {
    for (let i = Math.round(start * RATE); i < n; i++) {
      const t = i / RATE - start;
      let s = 0;
      freqs.forEach((f, k) => (s += Math.sin(2 * Math.PI * f * v * t) * Math.exp(-t / (decay / (1 + k * 0.35)))));
      out[i] += (s / freqs.length) * gain * Math.min(1, t / 0.002);
    }
  };

  switch (kind) {
    case "blade": {
      const x = new Float32Array(n).map(noise);
      bandpass(x, (i) => 2500 + 5000 * Math.min(1, i / (0.12 * RATE)), 2.5);
      for (let i = 0; i < n; i++) out[i] = x[i] * env(i / RATE, 0.01, 0.06) * 1.4;
      ring([2240, 3710, 5180, 6930], 0.28, 0.55, 0.05);
      break;
    }
    case "impact": {
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const f = 55 + 90 * Math.exp(-t / 0.04);
        out[i] = Math.sin(2 * Math.PI * f * t * v) * env(t, 0.003, 0.11) + noise() * env(t, 0.001, 0.012) * 0.6;
      }
      break;
    }
    case "boom": {
      const x = new Float32Array(n).map(noise);
      lowpass(x, (i) => 1800 * Math.exp(-i / (0.25 * RATE)) + 120);
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = x[i] * env(t, 0.008, 0.45) * 2.2 + Math.sin(2 * Math.PI * (40 + 40 * Math.exp(-t / 0.15)) * t) * env(t, 0.01, 0.5) * 0.8;
      }
      break;
    }
    case "gunshot": {
      const x = new Float32Array(n).map(noise);
      lowpass(x, (i) => 6000 * Math.exp(-i / (0.08 * RATE)) + 300);
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        out[i] = x[i] * (env(t, 0.0008, 0.035) * 1.6 + env(t, 0.03, 0.25) * 0.25);
      }
      break;
    }
    case "crash": {
      const x = new Float32Array(n).map(noise);
      highpass(x, 1500);
      for (let i = 0; i < n; i++) out[i] = x[i] * env(i / RATE, 0.004, 0.18) * 1.2;
      for (let k = 0; k < 9; k++) ring([3000 + (r() + 1) * 3500], 0.08, 0.35, 0.02 + (r() + 1) * 0.25);
      break;
    }
    case "clang":
      ring([520, 1290, 1870, 2650, 3420], 0.5, 1.0);
      for (let i = 0; i < 300; i++) out[i] += noise() * (1 - i / 300) * 0.5;
      break;
    case "screech": {
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const f = 2300 + 500 * Math.sin(2 * Math.PI * 7 * t) + 600 * (t / dur.screech);
        const saw = ((t * f * v) % 1) * 2 - 1;
        out[i] = (saw * 0.5 + noise() * 0.25) * env(t, 0.03, 0.35);
      }
      bandpass(out, (i) => 2600 + 400 * Math.sin(i / 900), 3);
      for (let i = 0; i < n; i++) out[i] *= 2.2;
      break;
    }
    case "whoosh": {
      const x = new Float32Array(n).map(noise);
      bandpass(x, (i) => 300 + 2200 * Math.sin((Math.PI * i) / n), 1.2);
      for (let i = 0; i < n; i++) out[i] = x[i] * Math.sin((Math.PI * i) / n) ** 2 * 1.8;
      break;
    }
    case "splash": {
      const x = new Float32Array(n).map(noise);
      lowpass(x, () => 2500);
      for (let i = 0; i < n; i++) out[i] = x[i] * env(i / RATE, 0.01, 0.15) * 1.3;
      for (let k = 0; k < 6; k++) {
        const s0 = 0.05 + (r() + 1) * 0.2, f0 = 500 + (r() + 1) * 600;
        for (let i = Math.round(s0 * RATE); i < Math.min(n, Math.round((s0 + 0.06) * RATE)); i++) {
          const t = i / RATE - s0;
          out[i] += Math.sin(2 * Math.PI * (f0 + 4000 * t) * t) * Math.exp(-t / 0.02) * 0.4;
        }
      }
      break;
    }
    case "knock": {
      for (const s0 of [0, 0.17, 0.32]) {
        for (let i = Math.round(s0 * RATE); i < n; i++) {
          const t = i / RATE - s0;
          if (t > 0.12) break;
          out[i] += (Math.sin(2 * Math.PI * 190 * v * t) * 0.8 + noise() * 0.5 * Math.exp(-t / 0.004)) * Math.exp(-t / 0.03);
        }
      }
      break;
    }
    case "zap": {
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const sq = Math.sign(Math.sin(2 * Math.PI * 110 * v * t)) * 0.35 + Math.sign(Math.sin(2 * Math.PI * 233 * t)) * 0.2;
        const crackle = r() > 0.97 ? noise() * 1.2 : 0;
        out[i] = (sq + crackle) * env(t, 0.005, 0.22);
      }
      highpass(out, 150);
      break;
    }
    case "roar": {
      const x = new Float32Array(n).map(noise);
      lowpass(x, () => 700);
      for (let i = 0; i < n; i++) {
        const t = i / RATE;
        const saw = ((t * 85 * v) % 1) * 2 - 1;
        const shape = Math.sin((Math.PI * Math.min(t, dur.roar)) / dur.roar);
        out[i] = (x[i] * 2 + saw * 0.35) * shape * (0.8 + 0.2 * Math.sin(2 * Math.PI * 13 * t));
      }
      break;
    }
    case "ding":
      ring([1318.5, 2637, 3955], 0.35, 0.9);
      break;
    case "chime": {
      // A soft two-note "notification" (E6 → B6), like a game's message pop-up.
      const note = (f: number, at: number) => {
        for (let i = Math.round(at * RATE); i < n; i++) {
          const t = i / RATE - at;
          out[i] += (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * Math.exp(-t / 0.18) * Math.min(1, t / 0.004) * 0.55;
        }
      };
      note(1318.5, 0);
      note(1975.5, 0.11);
      break;
    }
  }
  return out;
}

function wav(samples: Float32Array, padMs: number): Blob {
  const pad = Math.round((padMs / 1000) * RATE);
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 0 ? 0.6 / peak : 1; // effects sit a little below the voice
  const len = samples.length + pad;
  const buf = new ArrayBuffer(44 + len * 2);
  const d = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); d.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, RATE, true); d.setUint32(28, RATE * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  w(36, "data"); d.setUint32(40, len * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const fade = i > samples.length - 200 ? (samples.length - i) / 200 : 1;
    d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i] * gain * fade)) * 32767, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

const urls = new Map<string, string>();

/** A playable address for the sound of `word` (made once, then reused). */
export function fxUrl(kind: FxKind, word: string, padMs = 180): string {
  const key = `${kind}|${normal(word)}|${padMs}`;
  let u = urls.get(key);
  if (!u) urls.set(key, (u = URL.createObjectURL(wav(render(kind, seedOf(word || kind)), padMs))));
  return u;
}

/** Exposed for tests: the raw samples of an effect. */
export const _render = render;
