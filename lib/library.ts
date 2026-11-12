// The user's library, stored on the device (IndexedDB): books, chapters,
// the exact place you paused, and the voices you picked.
import type { Analysis, Chapter, Character, Provider } from "./types";

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
  tweaks?: Record<string, VoiceTweak>;
}

/** Per-character fine tuning of a device voice (1 = unchanged). */
export interface VoiceTweak {
  pitch: number;
  speed: number;
}

export type BookSummary = Pick<BookRecord, "id" | "title" | "openedAt" | "position" | "chapters"> & { total: number };

const DB = "voicebook";
const STORE = "books";
/** AI analysis per part of a book, so reopening or jumping back is instant and costs nothing. */
const ANALYSIS = "analysis";

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(ANALYSIS)) d.createObjectStore(ANALYSIS);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const analysisKey = (id: string, chunk: number) => `${id}\u0000${chunk}`;

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
  /** Read-modify-write inside ONE transaction, so two quick saves can't overwrite each other. */
  async patch(id: string, fields: Partial<BookRecord>) {
    try {
      const d = await db();
      await new Promise<void>((resolve, reject) => {
        const t = d.transaction(STORE, "readwrite");
        const s = t.objectStore(STORE);
        const g = s.get(id);
        g.onsuccess = () => g.result && s.put({ ...g.result, ...fields });
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error);
      });
    } catch {}
  },
  async remove(id: string) {
    try {
      await tx("readwrite", (s) => s.delete(id));
      await tx("readwrite", (s) => s.delete(IDBKeyRange.bound(analysisKey(id, 0).slice(0, -1), `${id}\u0000\uffff`)), ANALYSIS);
    } catch {}
  },
  async getAnalysis(id: string, chunk: number) {
    try {
      return (await tx("readonly", (s) => s.get(analysisKey(id, chunk)), ANALYSIS)) as Analysis | undefined;
    } catch {
      return undefined;
    }
  },
  async putAnalysis(id: string, chunk: number, a: Analysis) {
    try {
      await tx("readwrite", (s) => s.put(a, analysisKey(id, chunk)), ANALYSIS);
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
