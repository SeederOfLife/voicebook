// Generative background ambience + music, synthesised live with the Web Audio API.
// No audio files, no licensing, no network – and it never repeats exactly.
//
// Background sound should serve the story, not sit on top of it:
//  - ambience (rain, sea…) establishes a scene, then settles to a quiet bed;
//  - music plays for a moment (a chapter opening, a change of mood, an intense
//    line) and fades away again, unless the listener asks for it all the time.
import type { Ambience, Mood } from "./types";

type Layer = { out: GainNode; stop: () => void };

const NOTE = (n: string) => {
  const m = n.match(/^([A-G])(#|b)?(\d)$/)!;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as "C"];
  const semis = base + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) - 4) * 12 - 9;
  return 440 * Math.pow(2, semis / 12);
};

const PROGRESSIONS: Record<Exclude<Mood, "none">, { chords: string[][]; secs: number; bright: number; arp?: boolean; pulse?: boolean }> = {
  calm: { chords: [["C3", "E4", "G4", "B4"], ["A2", "C4", "E4", "G4"], ["F2", "A3", "C4", "E4"], ["G2", "B3", "D4", "E4"]], secs: 8, bright: 900 },
  warm: { chords: [["D3", "F#4", "A4", "C#5"], ["B2", "D4", "F#4", "A4"], ["G2", "B3", "D4", "F#4"], ["A2", "C#4", "E4", "A4"]], secs: 8, bright: 1000 },
  happy: { chords: [["C3", "E4", "G4", "C5"], ["G2", "D4", "G4", "B4"], ["A2", "C4", "E4", "A4"], ["F2", "C4", "F4", "A4"]], secs: 4, bright: 1600, arp: true },
  playful: { chords: [["F3", "A4", "C5"], ["C3", "G4", "E5"], ["D3", "A4", "F5"], ["Bb2", "F4", "D5"]], secs: 2.5, bright: 2200, arp: true },
  sad: { chords: [["A2", "C4", "E4", "G4"], ["F2", "A3", "C4", "E4"], ["D3", "F4", "A4", "C5"], ["E2", "G3", "B3", "D4"]], secs: 9, bright: 700 },
  tense: { chords: [["C2", "G3", "Eb4", "Ab4"], ["C2", "G3", "D4", "Ab4"], ["B1", "F#3", "D4", "G4"], ["C2", "G3", "Eb4", "B4"]], secs: 5, bright: 600, pulse: true },
  mysterious: { chords: [["D3", "A3", "E4", "F4"], ["Bb2", "F3", "D4", "A4"], ["G2", "D4", "Bb4", "C5"], ["A2", "E4", "C#5", "D5"]], secs: 9, bright: 700 },
  epic: { chords: [["D2", "D3", "A3", "F4"], ["Bb1", "Bb2", "F3", "D4"], ["F2", "F3", "C4", "A4"], ["C2", "C3", "G3", "E4"]], secs: 6, bright: 1400, pulse: true },
};

export class Soundscape {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private amb: { key: Ambience; layer: Layer } | null = null;
  /** `until` = when a music moment ends, in audio-clock seconds (null = plays on) */
  private mus: { key: Mood; layer: Layer; until: number | null } | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  volume = 0.45;

  /** Must be called from a click/tap the first time (browser autoplay rules). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noise = this.makeNoise(false);
      this.brown = this.makeNoise(true);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.2);
  }

  pause() {
    this.ctx?.suspend().catch(() => {});
  }
  resume() {
    if (this.ctx?.state === "suspended") this.ctx.resume().catch(() => {});
  }

  /** The scene's background sound: comes in, then settles to a quiet bed. */
  setAmbience(kind: Ambience) {
    if (!this.ctx || (this.amb?.key ?? "none") === kind) return;
    this.fadeOut(this.amb?.layer);
    this.amb = kind === "none" ? null : { key: kind, layer: this.establish(this.ambience(kind)) };
  }

  /** Music that keeps playing for a mood ("none" stops any music). */
  setMusic(mood: Mood) {
    if (!this.ctx) return;
    if (this.mus && this.mus.key === mood) {
      this.mus.until = null;
      return;
    }
    this.fadeOut(this.mus?.layer);
    this.mus = mood === "none" ? null : { key: mood, layer: this.fadeIn(this.music(mood)), until: null };
  }

  /** Music for a moment: fades in, plays for `seconds` of listening, then fades away. */
  musicMoment(mood: Mood, seconds: number) {
    if (!this.ctx || mood === "none") return;
    const until = this.ctx.currentTime + seconds;
    if (this.mus?.key === mood) {
      if (this.mus.until !== null) this.mus.until = Math.max(this.mus.until, until);
    } else {
      this.fadeOut(this.mus?.layer);
      this.mus = { key: mood, layer: this.fadeIn(this.music(mood)), until };
    }
    // The audio clock stands still while paused, so a moment lasts `seconds` of actual listening.
    this.watch ??= setInterval(() => {
      if (!this.ctx || !this.mus || this.mus.until === null || this.ctx.currentTime < this.mus.until) return;
      this.fadeOut(this.mus.layer, 6);
      this.mus = null;
    }, 1000);
  }

  /** True while music is sounding (used by the interface). */
  get musicPlaying(): Mood | null {
    return this.mus?.key ?? null;
  }

  stop() {
    this.setAmbience("none");
    this.setMusic("none");
  }

  // ---------- helpers ----------

  private makeNoise(brown: boolean) {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }

  private fadeIn(layer: Layer): Layer {
    const t = this.ctx!.currentTime;
    layer.out.gain.setValueAtTime(0, t);
    layer.out.gain.linearRampToValueAtTime(1, t + 3);
    layer.out.connect(this.master);
    return layer;
  }

  /** Ambience: fade in, hold while the scene is set, then drop to a quiet bed. */
  private establish(layer: Layer): Layer {
    const t = this.ctx!.currentTime;
    const g = layer.out.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(1, t + 3);
    g.setValueAtTime(1, t + 14);
    g.linearRampToValueAtTime(0.35, t + 26);
    layer.out.connect(this.master);
    return layer;
  }

  private fadeOut(layer?: Layer, seconds = 2.5) {
    if (!layer || !this.ctx) return;
    const t = this.ctx.currentTime;
    layer.out.gain.cancelScheduledValues(t);
    layer.out.gain.setValueAtTime(layer.out.gain.value, t);
    layer.out.gain.linearRampToValueAtTime(0, t + seconds);
    setTimeout(() => {
      layer.stop();
      layer.out.disconnect();
    }, seconds * 1000 + 300);
  }

  private src(buf: AudioBuffer) {
    const s = this.ctx!.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 3);
    return s;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private gain(v: number) {
    const g = this.ctx!.createGain();
    g.gain.value = v;
    return g;
  }

  private lfo(target: AudioParam, rate: number, depth: number) {
    const o = this.ctx!.createOscillator();
    const g = this.gain(depth);
    o.frequency.value = rate;
    o.connect(g).connect(target);
    o.start();
    return o;
  }

  /** Noise bed: source → filters → gain → out */
  private bed(out: GainNode, buf: AudioBuffer, filters: BiquadFilterNode[], level: number) {
    const s = this.src(buf);
    const g = this.gain(level);
    let node: AudioNode = s;
    for (const f of filters) node = node.connect(f);
    node.connect(g).connect(out);
    return { s, g };
  }

  /** Repeats `fn` at random intervals between min and max seconds. */
  private every(min: number, max: number, fn: () => void) {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!alive) return;
      if (this.ctx?.state === "running") fn();
      timer = setTimeout(tick, (min + Math.random() * (max - min)) * 1000);
    };
    timer = setTimeout(tick, Math.random() * max * 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }

  private burst(out: AudioNode, buf: AudioBuffer, freq: number, type: BiquadFilterType, level: number, attack: number, decay: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = this.filter(type, freq);
    const g = this.gain(0);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random() * 3);
    s.stop(t + attack + decay + 0.1);
  }

  private chirp(out: AudioNode, from: number, to: number, dur: number, level: number, type: OscillatorType = "sine") {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = this.gain(0);
    const t = ctx.currentTime;
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ---------- ambiences ----------

  private ambience(kind: Ambience): Layer {
    const out = this.gain(0);
    const stops: (() => void)[] = [];
    const nodes: AudioScheduledSourceNode[] = [];
    const add = (s: AudioScheduledSourceNode) => nodes.push(s);

    switch (kind) {
      case "rain":
      case "storm": {
        add(this.bed(out, this.noise, [this.filter("highpass", 900), this.filter("lowpass", 7000)], 0.09).s);
        add(this.bed(out, this.brown, [this.filter("lowpass", 900)], 0.25).s);
        stops.push(this.every(0.05, 0.4, () => this.burst(out, this.noise, 3000 + Math.random() * 4000, "bandpass", 0.05, 0.002, 0.04)));
        if (kind === "storm") {
          const w = this.bed(out, this.noise, [this.filter("bandpass", 500, 0.8)], 0.06);
          add(w.s);
          add(this.lfo(w.g.gain, 0.07, 0.05));
          stops.push(this.every(14, 30, () => this.burst(out, this.brown, 160 + Math.random() * 120, "lowpass", 1.4, 0.15, 4 + Math.random() * 3)));
        }
        break;
      }
      case "wind": {
        const f = this.filter("bandpass", 500, 1.2);
        const w = this.bed(out, this.noise, [f], 0.12);
        add(w.s);
        add(this.lfo(f.frequency, 0.05, 250));
        add(this.lfo(w.g.gain, 0.09, 0.07));
        break;
      }
      case "sea": {
        const w = this.bed(out, this.noise, [this.filter("lowpass", 700)], 0.14);
        add(w.s);
        add(this.lfo(w.g.gain, 0.11, 0.12));
        add(this.bed(out, this.brown, [this.filter("lowpass", 300)], 0.3).s);
        break;
      }
      case "fire": {
        add(this.bed(out, this.brown, [this.filter("lowpass", 500)], 0.35).s);
        stops.push(this.every(0.04, 0.6, () => this.burst(out, this.noise, 2500 + Math.random() * 3000, "highpass", 0.08 + Math.random() * 0.12, 0.001, 0.02 + Math.random() * 0.04)));
        break;
      }
      case "forest": {
        const f = this.filter("bandpass", 700, 0.6);
        const w = this.bed(out, this.noise, [f], 0.04);
        add(w.s);
        add(this.lfo(w.g.gain, 0.08, 0.03));
        stops.push(
          this.every(1.5, 6, () => {
            const base = 2200 + Math.random() * 2000;
            const n = 1 + Math.floor(Math.random() * 4);
            for (let i = 0; i < n; i++) setTimeout(() => this.chirp(out, base, base * (1.2 + Math.random() * 0.4), 0.08 + Math.random() * 0.08, 0.035), i * 120);
          }),
        );
        break;
      }
      case "night": {
        add(this.bed(out, this.brown, [this.filter("lowpass", 400)], 0.12).s);
        stops.push(
          this.every(0.6, 2.5, () => {
            const f = 4200 + Math.random() * 600;
            for (let i = 0; i < 3; i++) setTimeout(() => this.chirp(out, f, f * 0.98, 0.05, 0.015, "triangle"), i * 70);
          }),
        );
        stops.push(this.every(8, 20, () => this.chirp(out, 420, 360, 0.6, 0.02))); // distant owl-ish hoot
        break;
      }
      case "city": {
        add(this.bed(out, this.brown, [this.filter("lowpass", 260)], 0.45).s);
        const h = this.bed(out, this.noise, [this.filter("bandpass", 1100, 0.5)], 0.015);
        add(h.s);
        add(this.lfo(h.g.gain, 0.05, 0.01));
        stops.push(this.every(6, 18, () => this.burst(out, this.brown, 500, "bandpass", 0.25, 1.2, 2.5))); // passing car
        break;
      }
      case "cave": {
        const o = this.ctx!.createOscillator();
        o.frequency.value = 55;
        const g = this.gain(0.025);
        o.connect(this.filter("lowpass", 120)).connect(g).connect(out);
        o.start();
        add(o);
        const delay = this.ctx!.createDelay(1);
        delay.delayTime.value = 0.33;
        const fb = this.gain(0.45);
        delay.connect(fb).connect(delay);
        delay.connect(out);
        stops.push(this.every(1.5, 5, () => this.chirp(delay, 1400 + Math.random() * 900, 900, 0.12, 0.05)));
        break;
      }
    }
    return {
      out,
      stop: () => {
        stops.forEach((s) => s());
        nodes.forEach((n) => {
          try {
            n.stop();
          } catch {}
        });
      },
    };
  }

  // ---------- music ----------

  private music(mood: Mood): Layer {
    const out = this.gain(0);
    if (mood === "none") return { out, stop: () => {} };
    const p = PROGRESSIONS[mood];
    const ctx = this.ctx!;
    const bus = this.gain(0.05);
    const lp = this.filter("lowpass", p.bright, 0.4);
    bus.connect(lp).connect(out);
    // simple reverb-ish wash
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.45;
    const fb = this.gain(0.35);
    lp.connect(delay).connect(fb).connect(delay);
    delay.connect(out);

    let i = 0;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const playChord = () => {
      if (!alive) return;
      if (ctx.state === "running") {
        const chord = p.chords[i++ % p.chords.length];
        const t = ctx.currentTime;
        const dur = p.secs + 2;
        for (const n of chord) {
          for (const detune of [-6, 6]) {
            const o = ctx.createOscillator();
            o.type = "triangle";
            o.frequency.value = NOTE(n);
            o.detune.value = detune;
            const g = this.gain(0);
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.5, t + Math.min(2, p.secs / 3));
            g.gain.setValueAtTime(0.5, t + p.secs - 0.5);
            g.gain.linearRampToValueAtTime(0, t + dur);
            o.connect(g).connect(bus);
            o.start(t);
            o.stop(t + dur + 0.1);
          }
        }
        if (p.arp) {
          const step = p.secs / 8;
          for (let k = 0; k < 8; k++) {
            const n = chord[1 + (k % (chord.length - 1))];
            setTimeout(() => this.chirp(lp, NOTE(n) * 2, NOTE(n) * 2, step * 1.6, 0.03, "triangle"), k * step * 1000);
          }
        }
        if (p.pulse) {
          const beats = Math.round(p.secs / 0.5);
          for (let k = 0; k < beats; k++)
            setTimeout(() => this.chirp(lp, NOTE(chord[0]), NOTE(chord[0]) * 0.98, 0.35, 0.09, "sine"), k * 500);
        }
      }
      timer = setTimeout(playChord, p.secs * 1000);
    };
    playChord();
    return {
      out,
      stop: () => {
        alive = false;
        clearTimeout(timer);
      },
    };
  }
}
