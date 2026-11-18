"use client";

import { useMemo, useState } from "react";
import type { BookSummary } from "@/lib/library";
import { SHELVES, SORTS, sortKey, type SortBy } from "@/lib/shelf";
import { hash } from "@/lib/voices";

const SORT_KEY = "vb:lib-sort";

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
      title: (a, b) => sortKey(a.title).localeCompare(sortKey(b.title)),
      author: (a, b) => (a.author ?? "~").localeCompare(b.author ?? "~") || sortKey(a.title).localeCompare(sortKey(b.title)),
      progress: (a, b) => progressOf(b) - progressOf(a),
    };
    return [...list].sort(by[sort]);
  }, [books, query, sort]);

  const reading = books
    .filter((b) => b.started && progressOf(b) < 98)
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 3);
  const showShelves = books.length > 4 && !query;

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
      {showShelves
        ? SHELVES.map((sh) => {
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
          })
        : filtered.map(row)}
      {query && !filtered.length && <p className="muted small">No book matches “{query}”.</p>}
    </div>
  );
}
