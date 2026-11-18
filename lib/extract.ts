// Runs in the browser: turns an uploaded file into chapters of plain text.
import { detectSections, type Section } from "./chunk";

export interface ExtractedBook {
  title: string;
  author?: string;
  sections: Section[];
}

/** "Jane Austen - Pride and Prejudice" → author + title (when the file has no details inside). */
function fromFileName(name: string): { title: string; author?: string } {
  const raw = name.replace(/\.[^.]+$/, "").trim();
  const m = /^(.{3,40}?)\s+[-–—]\s+(.{2,})$/.exec(raw);
  if (m && /^[A-Z][\p{L}.'’ ]+$/u.test(m[1]) && m[1].split(" ").length <= 4)
    return { author: m[1].trim(), title: baseName(m[2]) };
  return { title: baseName(name) };
}

/** Details written inside a PDF are often junk ("Microsoft Word - doc1.docx"): keep only plausible ones. */
const plausible = (v: unknown): string | undefined => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (t.length < 2 || t.length > 120) return undefined;
  if (/\.(docx?|pdf|indd|tex|rtf|odt)$|^(untitled|microsoft|document|title|unknown|author|user|admin)\b/i.test(t)) return undefined;
  return t;
};

const baseName = (n: string) => n.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();

function tidy(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/^[ \t]*\d{1,4}[ \t]*$/gm, "") // lone page numbers
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2") // hyphenated line breaks
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let pdfMeta: { title?: string; author?: string } = {};

async function pdfSections(file: File, onProgress?: (p: number) => void): Promise<Section[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const info = ((await doc.getMetadata()).info ?? {}) as { Title?: unknown; Author?: unknown };
    pdfMeta = { title: plausible(info.Title), author: plausible(info.Author) };
  } catch {
    pdfMeta = {};
  }
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let out = "";
    let lastY: number | null = null;
    let lineH = 12;
    for (const item of content.items as any[]) {
      if (typeof item.str !== "string") continue;
      const y = item.transform?.[5] ?? 0;
      const h = Math.abs(item.height || item.transform?.[3] || 12);
      if (h > 2) lineH = h;
      if (lastY !== null && Math.abs(y - lastY) > lineH * 1.7) out += "\n\n";
      else if (lastY !== null && Math.abs(y - lastY) > lineH * 0.5 && !out.endsWith("\n")) out += "\n";
      out += item.str;
      if (item.hasEOL && !out.endsWith("\n")) out += "\n";
      lastY = y;
    }
    // Join wrapped lines inside a paragraph.
    const paragraphs = tidy(out)
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
      .filter(Boolean);
    pages.push(paragraphs.join("\n\n"));
    onProgress?.(i / doc.numPages);
  }
  const text = pages.join("\n\n").trim();
  if (text.replace(/\s/g, "").length < 50) {
    throw new Error("This PDF has no selectable text (it is probably a scan). Try a text-based PDF or EPUB.");
  }

  // Prefer the PDF's own table of contents (bookmarks) when it has one.
  try {
    const outline = await doc.getOutline();
    const items = outline && outline.length >= 2 ? outline : outline?.[0]?.items ?? [];
    const marks: { title: string; page: number }[] = [];
    for (const o of items) {
      let dest: any = o.dest;
      if (typeof dest === "string") dest = await doc.getDestination(dest);
      if (!Array.isArray(dest) || dest[0] == null) continue;
      const page = typeof dest[0] === "number" ? dest[0] : await doc.getPageIndex(dest[0]);
      if (!marks.length || page > marks[marks.length - 1].page) marks.push({ title: o.title.trim(), page });
    }
    if (marks.length >= 2) {
      const sections: Section[] = [];
      if (marks[0].page > 0) sections.push({ title: "Beginning", text: pages.slice(0, marks[0].page).join("\n\n") });
      marks.forEach((m, i) =>
        sections.push({ title: m.title, text: pages.slice(m.page, marks[i + 1]?.page ?? pages.length).join("\n\n") }),
      );
      const filled = sections.filter((x) => x.text.trim());
      if (filled.length >= 2) return filled;
    }
  } catch {
    /* no usable outline */
  }
  return detectSections(text);
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,nav,header,footer").forEach((n) => n.remove());
  const blocks = doc.body?.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dd,dt,td");
  if (blocks && blocks.length) {
    return Array.from(blocks)
      .filter((b) => !b.querySelector("p,li,h1,h2,h3,h4,h5,h6,blockquote")) // avoid duplicates
      .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n\n");
  }
  return (doc.body?.textContent ?? "").trim();
}

async function epubText(file: File): Promise<ExtractedBook> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = await zip.file("META-INF/container.xml")?.async("string");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error("Invalid EPUB file");
  const opf = await zip.file(opfPath)!.async("string");
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const xml = new DOMParser().parseFromString(opf, "application/xml");
  const title = xml.getElementsByTagName("dc:title")[0]?.textContent?.trim() || fromFileName(file.name).title;
  const author = plausible(xml.getElementsByTagName("dc:creator")[0]?.textContent) ?? fromFileName(file.name).author;
  const manifest = new Map<string, string>();
  Array.from(xml.getElementsByTagName("item")).forEach((it) =>
    manifest.set(it.getAttribute("id") ?? "", it.getAttribute("href") ?? ""),
  );
  const raw: Section[] = [];
  for (const ref of Array.from(xml.getElementsByTagName("itemref"))) {
    const href = manifest.get(ref.getAttribute("idref") ?? "");
    if (!href) continue;
    const path = decodeURIComponent(dir + href.split("#")[0]);
    const html = await zip.file(path)?.async("string");
    if (!html) continue;
    const text = tidy(htmlToText(html));
    if (!text) continue;
    const h = new DOMParser().parseFromString(html, "text/html").querySelector("h1,h2,h3,title");
    raw.push({ title: (h?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80), text });
  }
  // Fold tiny pages (cover, copyright, dedication) into the next chapter.
  const sections: Section[] = [];
  let carry = "";
  for (const sec of raw) {
    if (sec.text.length < 400) {
      carry = carry ? `${carry}\n\n${sec.text}` : sec.text;
      continue;
    }
    sections.push({ title: sec.title || `Chapter ${sections.length + 1}`, text: carry ? `${carry}\n\n${sec.text}` : sec.text });
    carry = "";
  }
  if (carry) sections.push({ title: `Chapter ${sections.length + 1}`, text: carry });
  if (!sections.length) throw new Error("No readable text in this EPUB");
  return { title, author, sections };
}

function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^(#{1,3})\s*(.+)$/gm, "\n\n$1 $2\n\n")
    .replace(/^#{4,6}\s*(.+)$/gm, "\n$1\n")
    .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, "$1");
}

export async function extractText(file: File, onProgress?: (p: number) => void): Promise<ExtractedBook> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const named = fromFileName(file.name);
  const { title, author } = named;
  if (ext === "pdf" || file.type === "application/pdf") {
    const sections = await pdfSections(file, onProgress);
    return { title: pdfMeta.title ?? title, author: pdfMeta.author ?? author, sections };
  }
  if (ext === "epub") return epubText(file);
  const raw = await file.text();
  if (ext === "html" || ext === "htm") return { title, author, sections: detectSections(tidy(htmlToText(raw))) };
  if (ext === "md" || ext === "markdown") return { title, author, sections: detectSections(tidy(markdownToText(raw))) };
  return { title, author, sections: detectSections(tidy(raw)) };
}
