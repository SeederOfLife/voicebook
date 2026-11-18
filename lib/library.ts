import { shelfFor, type Shelf } from "./shelf";
// The user's library, stored on the device (IndexedDB): books, chapters, the exact
// place you paused, the voices you picked, and the audio that was already generated
// (so nothing is ever generated twice and saved passages play without a connection).
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
  /** The whole book was scanned for its characters. */
  scanned?: boolean;
  /** The AI cast the characters (names merged, voices chosen). */
  aiCast?: boolean;
  /** Characters whose voice the listener chose by hand (kept over automatic choices). */
  manualVoices?: string[];
  author?: string;
  /** Library shelf (stories, guides, …). */
  shelf?: Shelf;
  /** Where it came from, e.g. "Download" (a folder on the phone) or a file name. */
  source?: string;
  /** Folder it was found in on the phone, e.g. "Download/Books/Dune". */
  folder?: string;
  /** Original file name (keeps the folder's order, e.g. "01 - Dune.epub"). */
  fileName?: string;
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

export type BookSummary = Pick<BookRecord, "id" | "title" | "openedAt" | "addedAt" | "position" | "chapters" | "author" | "source" | "folder" | "fileName"> & {
  total: number;
  shelf: Shelf;
  /** Opened at least once (books imported in bulk are "new" until then) */
  started: boolean;
};

const DB = "voicebook";
const STORE = "books";
/** AI analysis per part of a book, so reopening or jumping back is instant and costs nothing. */
const ANALYSIS = "analysis";
/** Generated speech per passage: { type, buf } keyed by book + passage. */
const AUDIO = "audio";

export interface SavedAudio {
  type: string;
  buf: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(ANALYSIS)) d.createObjectStore(ANALYSIS);
      if (!d.objectStoreNames.contains(AUDIO)) d.createObjectStore(AUDIO);
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
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    t.onabort = () => reject(t.error ?? new Error("storage full"));
  });
}

const analysisKey = (id: string, chunk: number) => `${id}\u0000${chunk}`;
const audioKey = (id: string, key: string) => `${id}\u0000${key}`;
const ofBook = (id: string) => IDBKeyRange.bound(`${id}\u0000`, `${id}\u0000\uffff`);

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
      await tx("readwrite", (s) => s.delete(ofBook(id)), ANALYSIS);
      await tx("readwrite", (s) => s.delete(ofBook(id)), AUDIO);
    } catch {}
  },
  async getAudio(id: string, key: string) {
    try {
      return (await tx("readonly", (s) => s.get(audioKey(id, key)), AUDIO)) as SavedAudio | undefined;
    } catch {
      return undefined;
    }
  },
  /** Returns false when the device has no room left. */
  async putAudio(id: string, key: string, audio: SavedAudio): Promise<boolean> {
    try {
      await tx("readwrite", (s) => s.put(audio, audioKey(id, key)), AUDIO);
      return true;
    } catch {
      return false;
    }
  },
  /** Delete a book's saved audio (the book and your place in it stay). */
  async clearAudio(id: string) {
    try {
      await tx("readwrite", (s) => s.delete(ofBook(id)), AUDIO);
    } catch {}
  },
  /** How many passages of a book have saved audio. */
  async countAudio(id: string): Promise<number> {
    try {
      return await tx("readonly", (s) => s.count(ofBook(id)), AUDIO);
    } catch {
      return 0;
    }
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
        .map(({ id, title, openedAt, addedAt, position, chapters, chunks, author, source, shelf, folder, fileName }) => ({
          id,
          title,
          openedAt,
          addedAt,
          position,
          chapters,
          author,
          source,
          folder: folder ?? (source && source !== "shared" ? source : undefined),
          fileName,
          total: chunks.length,
          shelf: shelf ?? shelfFor(chunks),
          started: openedAt > addedAt + 1000 || position.chunk > 0 || position.offset > 0,
        }));
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
