"use client";

import React, { useMemo, useState } from "react";
import type { BookSummary } from "@/lib/library";
import { SHELVES, SORTS, sortKey, type SortBy } from "@/lib/shelf";
import { hash } from "@/lib/voices";

const SORT_KEY = "vb:lib-sort";
const VIEW_KEY = "vb:lib-view";
type View = "folders" | "shelves" | "authors";

/** "2 - Dune Messiah" after "1 - Dune", "Book 10" after "Book 9". */
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

interface Folder {
  name: string;
  path: string;
  books: BookSummary[];
  sub: Map<string, Folder>;
}

function folderTree(books: BookSummary[]): Folder {
  const root: Folder = { name: "", path: "", books: [], sub: new Map() };
  for (const b of books) {
    let node = root;
    const parts = (b.folder ?? "").split("/").filter(Boolean);
    for (const part of parts) {
      if (!node.sub.has(part)) node.sub.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, books: [], sub: new Map() });
      node = node.sub.get(part)!;
    }
    node.books.push(b);
  }
  return root;
}

/** Folders that hold only one subfolder and no books are merged ("Download / Books / Dune"). */
function squash(f: Folder): Folder {
  let node = f;
  while (node.books.length === 0 && node.sub.size === 1) {
    const only = [...node.sub.values()][0];
    node = { ...only, name: node.name ? `${node.name} / ${only.name}` : only.name };
  }
  return node;
}

const countBooks = (f: Folder): number => f.books.length + [...f.sub.values()].reduce((a, s) => a + countBooks(s), 0);

function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const progressOf = (b: BookSummary) => Math.round((b.position.chunk / Math.max(1, b.total)) * 100);

/** The private library: everything stays on this device. */
export function LibraryView({
  books,
  onOpen,
  onRemove,
}: {
  books: BookSummary[];
  onOpen: (id: string) => void;
  onRemove: (b: BookSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortBy>(() => {
    try {
      return (localStorage.getItem(SORT_KEY) as SortBy) || "recent";
    } catch {
      return "recent";
    }
  });
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY) as View | null;
      if (v) return v;
    } catch {}
    return books.some((b) => b.folder) ? "folders" : "shelves";
  });
  const chooseView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };
  const chooseSort = (s: SortBy) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {}
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? books.filter((b) => `${b.title} ${b.author ?? ""} ${b.source ?? ""}`.toLowerCase().includes(q)) : books;
    const by: Record<SortBy, (a: BookSummary, b: BookSummary) => number> = {
      recent: (a, b) => b.openedAt - a.openedAt,
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => natural(a.fileName ?? sortKey(a.title), b.fileName ?? sortKey(b.title)),
      author: (a, b) => (a.author ?? "~").localeCompare(b.author ?? "~") || sortKey(a.title).localeCompare(sortKey(b.title)),
      progress: (a, b) => progressOf(b) - progressOf(a),
    };
    return [...list].sort(by[sort]);
  }, [books, query, sort]);

  const reading = books
    .filter((b) => b.started && progressOf(b) < 98)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 3);
  const grouped = books.length > 3 && !query;

  const row = (b: BookSummary) => {
    const ch = [...b.chapters].reverse().find((c) => c.chunk <= b.position.chunk);
    const pct = progressOf(b);
    const line = [b.author, !b.started ? "New" : `${ch?.title ? `${ch.title} · ` : ""}${pct}%`, b.started ? timeAgo(b.openedAt) : null]
      .filter(Boolean)
      .join(" · ");
    return (
      <div key={b.id} className="book-row">
        <button className="book-open" onClick={() => onOpen(b.id)}>
          <span className="book-cover" style={{ background: `hsl(${hash(b.title) % 360} 35% 30%)` }}>
            {sortKey(b.title)[0]?.toUpperCase() ?? "?"}
          </span>
          <span className="book-info">
            <strong>{b.title}</strong>
            <span className="muted small">{line}</span>
            {b.started && <span className="mini-bar"><span style={{ width: `${pct}%` }} /></span>}
          </span>
          <span className="resume">▶</span>
        </button>
        <button className="icon-btn subtle" aria-label={`Remove ${b.title}`} onClick={() => onRemove(b)}>✕</button>
      </div>
    );
  };

  const renderFolder = (raw: Folder, depth: number): React.ReactNode => {
    const f = depth === 0 ? raw : squash(raw);
    const subs = [...f.sub.values()].sort((a, b) => natural(a.name, b.name));
    // In a folder, books keep the folder's order (file names) unless another order is chosen.
    const list = sort === "recent" ? [...f.books].sort((a, b) => natural(a.fileName ?? a.title, b.fileName ?? b.title)) : filtered.filter((b) => f.books.includes(b));
    const inner = (
      <>
        {subs.map((s) => renderFolder(s, depth + 1))}
        {list.map(row)}
      </>
    );
    if (depth === 0) return inner;
    return (
      <details key={f.path} className="shelf folder" open style={{ marginLeft: Math.min(depth - 1, 4) * 10 }}>
        <summary>
          📁 {f.name} <span className="muted small">{countBooks(f)}</span>
        </summary>
        {inner}
      </details>
    );
  };

  const renderGroups = () => {
    if (view === "folders") {
      const tree = folderTree(filtered);
      const loose = tree.books;
      tree.books = [];
      return (
        <>
          {renderFolder(tree, 0)}
          {loose.length > 0 && (
            <details className="shelf folder" open>
              <summary>
                📄 Added files <span className="muted small">{loose.length}</span>
              </summary>
              {loose.map(row)}
            </details>
          )}
        </>
      );
    }
    if (view === "authors") {
      const by = new Map<string, BookSummary[]>();
      for (const b of filtered) by.set(b.author ?? "Unknown author", [...(by.get(b.author ?? "Unknown author") ?? []), b]);
      return [...by]
        .sort((a, b) => (a[0] === "Unknown author" ? 1 : b[0] === "Unknown author" ? -1 : natural(a[0], b[0])))
        .map(([author, list]) => (
          <details key={author} className="shelf" open>
            <summary>
              ✍️ {author} <span className="muted small">{list.length}</span>
            </summary>
            {[...list].sort((a, b) => natural(a.fileName ?? a.title, b.fileName ?? b.title)).map(row)}
          </details>
        ));
    }
    return SHELVES.map((sh) => {
      const list = filtered.filter((b) => b.shelf === sh.id);
      if (!list.length) return null;
      return (
        <details key={sh.id} className="shelf" open>
          <summary>
            {sh.title} <span className="muted small">{list.length}</span>
          </summary>
          {list.map(row)}
        </details>
      );
    });
  };

  return (
    <div className="library">
      {reading.length > 0 && !query && (
        <>
          <h3 className="section-label">Continue listening</h3>
          {reading.map(row)}
        </>
      )}
      <div className="lib-head">
        <h3 className="section-label">My library · {books.length} book{books.length === 1 ? "" : "s"}</h3>
        <span className="muted small">🔒 Kept only on this device</span>
      </div>
      {books.length > 3 && (
        <div className="lib-tools">
          <input type="search" placeholder="Search title or author…" value={query} onChange={(x) => setQuery(x.target.value)} />
          <select value={sort} onChange={(x) => chooseSort(x.target.value as SortBy)} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>
      )}
      {books.length > 3 && (
        <div className="seg-toggle lib-views" role="tablist" aria-label="Arrange by">
          {(["folders", "shelves", "authors"] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => chooseView(v)}>
              {v === "folders" ? "📁 Folders" : v === "shelves" ? "📚 Shelves" : "✍️ Authors"}
            </button>
          ))}
        </div>
      )}
      {grouped ? renderGroups() : filtered.map(row)}
      {query && !filtered.length && <p className="muted small">No book matches “{query}”.</p>}
    </div>
  );
}
