/** Split a long text into sentence-aligned pieces no longer than `max`. */
export function splitSentences(text: string, max: number): string[] {
  const sentences =
    text.match(/[^.!?…]+(?:[.!?…]+["”»’)\]]*\s*|$)/g)?.filter((s) => s.trim()) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (let s of sentences) {
    // A single giant "sentence" (lists, poetry without punctuation…): hard-split on spaces.
    while (s.length > max) {
      let cut = s.lastIndexOf(", ", max);
      if (cut < max * 0.4) cut = s.lastIndexOf(" ", max);
      if (cut < max * 0.4) cut = max;
      if (cur) {
        out.push(cur.trim());
        cur = "";
      }
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1);
    }
    if (cur && cur.length + s.length > max) {
      out.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Split a document into parts that are analysed one at a time.
 * The first part is small so reading can start quickly.
 */
export function splitIntoChunks(text: string, first = 1400, size = 3200): string[] {
  const paras = text
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const limit = () => (out.length === 0 ? first : size);
  for (const p of paras) {
    const pieces = p.length > limit() ? splitSentences(p, limit()) : [p];
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > limit()) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Keep each spoken segment short enough for TTS engines and quick to start. */
export function splitLongSegments<T extends { text: string }>(segs: T[], max = 600): T[] {
  return segs.flatMap((seg) =>
    seg.text.length <= max
      ? [seg]
      : splitSentences(seg.text, max).map((t) => ({ ...seg, text: t })),
  );
}

// ---------- chapters ----------

export interface Section {
  title: string;
  text: string;
}

const NUM = String.raw`(\d{1,3}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|premier|première|první|druhá|třetí)`;
// "Chapter 3", "CHAPTER THREE — The Storm", "Kapitola 2: Bouře", "Part II"
const NUMBERED_RE = new RegExp(
  String.raw`^(chapter|chapitre|kapitola|capítulo|capitulo|capitolo|kapitel|hoofdstuk|rozdział|глава|part|partie|část|teil|book|livre|kniha)\s+${NUM}\b\.?(\s*[:.\-–—]?\s+\S.{0,60})?$`,
  "i",
);
// "Prologue", "Epilogue — Ten years later", "Appendix B"
const NAMED_RE =
  /^(prologue|prolog|epilogue|épilogue|epilog|introduction|úvod|einleitung|conclusion|závěr|preface|préface|předmluva|vorwort|foreword|afterword|acknowledge?ments|appendix(\s+[a-z\d])?|annexe(\s+[a-z\d])?|příloha(\s+[a-z\d])?)(\s*[:\-–—]\s*\S.{0,60})?$/i;
// "# Markdown heading", a lone Roman numeral ("IV.") or a lone number ("12")
const BARE_RE = /^(#{1,3}\s+\S.*|[IVXLC]{1,7}\.?|\d{1,3}\.?)$/;

const isHeadingLine = (p: string) =>
  p.length <= 80 &&
  (BARE_RE.test(p) || ((NUMBERED_RE.test(p) || NAMED_RE.test(p)) && !/[,;!?]$/.test(p) && !/[a-z]\.$/.test(p.slice(20))));

const cleanHeading = (s: string) => s.replace(/^#{1,3}\s+/, "").replace(/\s+/g, " ").trim();

/** Find chapter headings in plain text. Returns one untitled section if none are found. */
export function detectSections(text: string): Section[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sections: Section[] = [];
  let cur: Section = { title: "", text: "" };
  for (const p of paras) {
    const isHeading = isHeadingLine(p);
    if (isHeading) {
      if (cur.text.trim()) sections.push(cur);
      // Merge "CHAPTER 1" + "The Storm" style two-line headings.
      cur = { title: cleanHeading(p), text: cleanHeading(p) };
      continue;
    }
    if (cur.title && cur.text === cur.title && p.length < 60 && !/[.!?]$/.test(p)) {
      cur.title = `${cur.title} — ${p}`;
    }
    cur.text = cur.text ? `${cur.text}\n\n${p}` : p;
  }
  if (cur.text.trim()) sections.push(cur);
  const titled = sections.filter((s) => s.title);
  if (titled.length < 2) return [{ title: "", text: paras.join("\n\n") }];
  if (!sections[0].title) {
    if (sections[0].text.length < 400 && sections[1]) {
      // A title page / epigraph: read it, but don't make it a chapter of its own.
      sections[1] = { ...sections[1], text: `${sections[0].text}\n\n${sections[1].text}` };
      sections.shift();
    } else sections[0].title = "Beginning";
  }
  return sections;
}

/** Turn sections into analysable chunks + a chapter list pointing at chunk indices. */
export function buildBook(sections: Section[]): { chunks: string[]; chapters: { title: string; chunk: number }[] } {
  const chunks: string[] = [];
  const chapters: { title: string; chunk: number }[] = [];
  for (const s of sections) {
    const parts = splitIntoChunks(s.text, chunks.length === 0 ? 1400 : 3200);
    if (!parts.length) continue;
    if (s.title) chapters.push({ title: s.title, chunk: chunks.length });
    chunks.push(...parts);
  }
  if (chapters.length < 2) {
    // No real chapters: offer evenly spaced parts so you can still jump around.
    chapters.length = 0;
    const every = Math.max(1, Math.ceil(chunks.length / Math.min(30, Math.max(1, Math.ceil(chunks.length / 4)))));
    for (let c = 0; c < chunks.length; c += every) chapters.push({ title: c === 0 ? "Start" : `Part ${chapters.length + 1}`, chunk: c });
  }
  return { chunks, chapters };
}
