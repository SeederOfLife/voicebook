// Audio encoders for the studio voice (server side).

type Lame = typeof import("@breezystack/lamejs");
let lame: Promise<Lame> | null = null;

function toInt16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

/** MP3 keeps a whole book small enough to store on a phone (about 36 MB per hour at 80 kbps). */
export async function encodeMp3(samples: Float32Array, sampleRate: number, kbps = 80): Promise<Uint8Array> {
  // Loaded on demand as an ES module (the package's CommonJS build has no exports).
  lame ??= import("@breezystack/lamejs");
  const { Mp3Encoder } = await lame;
  const pcm = toInt16(samples);
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const chunks: Uint8Array[] = [];
  const block = 1152 * 32;
  for (let i = 0; i < pcm.length; i += block) {
    const out = encoder.encodeBuffer(pcm.subarray(i, i + block));
    if (out.length) chunks.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
  }
  const end = encoder.flush();
  if (end.length) chunks.push(new Uint8Array(end.buffer, end.byteOffset, end.length).slice());
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const mp3 = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    mp3.set(c, offset);
    offset += c.length;
  }
  return mp3;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = toInt16(samples);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}
