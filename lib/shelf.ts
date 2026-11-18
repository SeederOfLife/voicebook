// Sorts books onto shelves of the private library (kept on this device only).

export type Shelf = "stories" | "guides" | "nonfiction" | "documents";

export const SHELVES: { id: Shelf; title: string }[] = [
  { id: "stories", title: "Stories & novels" },
  { id: "nonfiction", title: "Non-fiction & learning" },
  { id: "guides", title: "Guides & how-to" },
  { id: "documents", title: "Documents & articles" },
];

const QUOTES = /“[^”]{1,600}”|"[^"\n]{1,600}"|«[^»]{1,600}»|‘[^’\n]{1,600}’/g;

/** Looks at a few samples of the book to decide its shelf. */
export function shelfFor(chunks: string[]): Shelf {
  const text = chunks.join("\n\n");
  const words = text.split(/\s+/).length;
  if (words < 4000) return "documents";
  // Samples from the start, middle and end, skipping the very beginning (contents, preface).
  const n = chunks.length;
  const picks = [Math.floor(n * 0.2), Math.floor(n * 0.5), Math.floor(n * 0.8)].map((i) => chunks[Math.min(n - 1, i)] ?? "");
  const sample = picks.join("\n\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
  const per10k = (re: RegExp) => ((sample.match(re) ?? []).length / Math.max(1, sample.length)) * 10_000;
  const dialogue = per10k(QUOTES);
  const said = per10k(/\b(said|asked|replied|whispered|shouted|cried|murmured)\b/gi);
  const steps = per10k(/^\s*(\d+[.)]|step\s+\d+|[-•*▪])\s+/gim);
  const howto = per10k(/\b(you can|you should|click|select|install|configure|tip|example|ingredients|recipe|tablespoons?|exercise)\b/gi);
  if (dialogue >= 6 || said >= 3) return "stories";
  if (steps >= 3 || howto >= 6) return "guides";
  return "nonfiction";
}

export type SortBy = "recent" | "added" | "title" | "author" | "progress";

export const SORTS: { id: SortBy; label: string }[] = [
  { id: "recent", label: "Recently read" },
  { id: "added", label: "Recently added" },
  { id: "title", label: "Title" },
  { id: "author", label: "Author" },
  { id: "progress", label: "Progress" },
];

/** "The Hobbit" sorts under H. */
export const sortKey = (title: string) => title.replace(/^(the|a|an|le|la|les|der|die|das)\s+/i, "").toLowerCase();
