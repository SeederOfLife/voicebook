// The user's library, stored on the device (IndexedDB): books, chapters,
// the exact place you paused, and the voices you picked.
import type { Chapter, Character, Provider } from "./types";

export interface BookRecord {
  id: string;
  title: string;
  chunks: string[];
  chapters: Chapter[];
  addedAt: number;
  openedAt: number;
  position: { chunk: number; offset: number };
  characters?: Character[];
  meta?: { genre: string; language: string; narrationStyle: string };
  casting?: Partial<Record<Provider, Record<string, string>>>;
  accents?: Record<string, string>;
}

export type BookSummary = Pick<BookRecord, "id" | "title" | "openedAt" | "position" | "chapters"> & { total: number };

const DB = "voicebook";
const STORE = "books";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const library = {
  async get(id: string) {
    try {
      return (await tx("readonly", (s) => s.get(id))) as BookRecord | undefined;
    } catch {
      return undefined;
    }
  },
  async put(book: BookRecord) {
    try {
      await tx("readwrite", (s) => s.put(book));
    } catch {}
  },
  async patch(id: string, fields: Partial<BookRecord>) {
    const b = await this.get(id);
    if (b) await this.put({ ...b, ...fields });
  },
  async remove(id: string) {
    try {
      await tx("readwrite", (s) => s.delete(id));
    } catch {}
  },
  async list(): Promise<BookSummary[]> {
    try {
      const all = (await tx("readonly", (s) => s.getAll())) as BookRecord[];
      return all
        .sort((a, b) => b.openedAt - a.openedAt)
        .map(({ id, title, openedAt, position, chapters, chunks }) => ({ id, title, openedAt, position, chapters, total: chunks.length }));
    } catch {
      return [];
    }
  },
};

export function bookId(title: string, text: string) {
  let h = 5381;
  const sample = text.length > 20000 ? text.slice(0, 10000) + text.slice(-10000) : text;
  for (let i = 0; i < sample.length; i++) h = ((h << 5) + h + sample.charCodeAt(i)) | 0;
  return `${title.slice(0, 40)}-${text.length}-${(h >>> 0).toString(36)}`;
}
