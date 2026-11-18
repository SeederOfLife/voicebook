// Share books directly between devices (peer to peer, WebRTC). A short code pairs two
// devices; the book itself goes straight from one to the other and is not stored on any
// server. Pairing uses the free PeerJS broker (it only passes the connection details).
import type { DataConnection, Peer as PeerType } from "peerjs";
import { library, type BookRecord } from "./library";

const PREFIX = "voicebook-share-";

/** Connection helpers: STUN finds a direct route; TURN relays when phones are behind strict networks. */
const ICE: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

export interface Offer {
  id: string;
  title: string;
  author?: string;
  chars: number;
}

type Msg =
  | { t: "hello"; device: string; books: Offer[] }
  | { t: "want"; ids: string[] }
  | { t: "book"; record: BookRecord; n: number; of: number }
  | { t: "done" };

/** Overridable for tests: { host, port, path, secure }. */
function brokerOptions(): Record<string, unknown> {
  try {
    const custom = localStorage.getItem("vb:p2p-broker");
    if (custom) return JSON.parse(custom);
  } catch {}
  return {};
}

async function newPeer(id?: string): Promise<PeerType> {
  const { Peer } = await import("peerjs");
  const opts = { ...brokerOptions(), debug: 0, config: { iceServers: ICE } };
  const peer = id ? new Peer(id, opts) : new Peer(opts);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the pairing service didn't answer (check the connection)")), 15000);
    peer.on("open", () => (clearTimeout(t), resolve()));
    peer.on("error", (e) => (clearTimeout(t), reject(e)));
  });
  return peer;
}

const deviceName = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows computer";
  return "computer";
};

export interface Sharing {
  code: string;
  stop: () => void;
}

/**
 * Offer books from this device. Returns the code to type on the other device.
 * `onStatus` receives plain-language progress.
 */
export async function shareBooks(ids: string[], onStatus: (s: string) => void): Promise<Sharing> {
  let peer: PeerType | null = null;
  let code = "";
  for (let attempt = 0; attempt < 4 && !peer; attempt++) {
    code = String(Math.floor(100000 + Math.random() * 900000));
    try {
      peer = await newPeer(PREFIX + code);
    } catch (e) {
      if (!String((e as { type?: string }).type ?? e).includes("unavailable-id")) throw e;
    }
  }
  if (!peer) throw new Error("couldn't get a sharing code, try again");
  const p = peer;
  const records = (await Promise.all(ids.map((id) => library.get(id)))).filter(Boolean) as BookRecord[];
  const offers: Offer[] = records.map((r) => ({ id: r.id, title: r.title, author: r.author, chars: r.chunks.reduce((a, c) => a + c.length, 0) }));

  p.on("connection", (conn: DataConnection) => {
    onStatus("A device connected…");
    conn.on("open", () => conn.send({ t: "hello", device: deviceName(), books: offers } satisfies Msg));
    conn.on("data", async (raw) => {
      const m = raw as Msg;
      if (m.t !== "want") return;
      const wanted = records.filter((r) => m.ids.includes(r.id));
      for (let i = 0; i < wanted.length; i++) {
        onStatus(`Sending “${wanted[i].title}” (${i + 1} of ${wanted.length})…`);
        // Saved audio is not sent (large); the other device makes its own.
        const { casting, accents, tweaks, ...record } = wanted[i];
        void casting; void accents; void tweaks;
        conn.send({ t: "book", record: record as BookRecord, n: i + 1, of: wanted.length } satisfies Msg);
        await new Promise((r) => setTimeout(r, 150));
      }
      conn.send({ t: "done" } satisfies Msg);
      onStatus(`Sent ${wanted.length} book${wanted.length === 1 ? "" : "s"}. You can share again with the same code.`);
    });
  });
  p.on("disconnected", () => p.reconnect());
  return { code, stop: () => p.destroy() };
}

/**
 * Connect to a device that is sharing. `choose` gets the offered books and returns the ids
 * to receive. Received books are added to the library (progress included).
 */
export async function receiveBooks(
  code: string,
  choose: (from: string, offers: Offer[]) => Promise<string[]>,
  onStatus: (s: string) => void,
): Promise<number> {
  const clean = code.replace(/\D/g, "");
  if (clean.length !== 6) throw new Error("the code has 6 digits");
  onStatus("Connecting…");
  const peer = await newPeer();
  try {
    const conn = peer.connect(PREFIX + clean, { reliable: true, serialization: "binary" });
    return await new Promise<number>((resolve, reject) => {
      let got = 0;
      const t = setTimeout(() => reject(new Error("no device is sharing with this code (or it can't be reached)")), 25000);
      peer.on("error", (e) => reject(new Error(String((e as { type?: string }).type) === "peer-unavailable" ? "no device is sharing with this code" : String(e))));
      conn.on("error", (e) => reject(e));
      conn.on("data", async (raw) => {
        const m = raw as Msg;
        if (m.t === "hello") {
          clearTimeout(t);
          const ids = await choose(m.device, m.books);
          if (!ids.length) return resolve(0);
          onStatus(`Receiving ${ids.length} book${ids.length === 1 ? "" : "s"}…`);
          conn.send({ t: "want", ids } satisfies Msg);
        } else if (m.t === "book") {
          const r = m.record;
          const existing = await library.get(r.id);
          // Keep the furthest reading position of the two devices.
          const position = existing && existing.position.chunk > r.position.chunk ? existing.position : r.position;
          await library.put({ ...existing, ...r, position, addedAt: existing?.addedAt ?? Date.now(), source: r.source ?? "shared" });
          got++;
          onStatus(`Received “${r.title}” (${m.n} of ${m.of})`);
        } else if (m.t === "done") resolve(got);
      });
    });
  } finally {
    setTimeout(() => peer.destroy(), 500);
  }
}
