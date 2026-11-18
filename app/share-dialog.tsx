"use client";

import { useEffect, useRef, useState } from "react";
import type { BookSummary } from "@/lib/library";
import { receiveBooks, shareBooks, type Offer, type Sharing } from "@/lib/p2p";

/** Send books to another device, or receive from one, with a 6-digit code. */
export function ShareDialog({ books, onClose, onReceived }: { books: BookSummary[]; onClose: () => void; onReceived: () => void }) {
  const [tab, setTab] = useState<"send" | "receive">(books.length ? "send" : "receive");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(books.slice(0, 1).map((b) => b.id)));
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [offer, setOffer] = useState<{ from: string; books: Offer[]; pick: Set<string> } | null>(null);
  const answer = useRef<((ids: string[]) => void) | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => sharing?.stop(), [sharing]);

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      setStatus("Getting a code…");
      const s = await shareBooks([...picked], setStatus);
      setSharing(s);
      setStatus("Waiting for the other device…");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const receive = async () => {
    setError(null);
    setBusy(true);
    try {
      const n = await receiveBooks(
        code,
        (from, list) =>
          new Promise<string[]>((resolve) => {
            answer.current = resolve;
            setOffer({ from, books: list, pick: new Set(list.map((b) => b.id)) });
            setStatus("");
          }),
        setStatus,
      );
      setOffer(null);
      setStatus(n ? `Done: ${n} book${n === 1 ? "" : "s"} added to your library.` : "Nothing received.");
      onReceived();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  return (
    <div className="modal-bg sheet-bg" onClick={onClose}>
      <div className="card modal voice-sheet" onClick={(x) => x.stopPropagation()} role="dialog" aria-label="Share books">
        <div className="row between">
          <h3>Share books between devices</h3>
          <button className="icon small-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="seg-toggle" role="tablist">
          <button role="tab" aria-selected={tab === "send"} className={tab === "send" ? "on" : ""} onClick={() => setTab("send")} disabled={!!sharing}>
            Send from here
          </button>
          <button role="tab" aria-selected={tab === "receive"} className={tab === "receive" ? "on" : ""} onClick={() => setTab("receive")} disabled={!!sharing}>
            Receive here
          </button>
        </div>

        {tab === "send" && !sharing && (
          <>
            <p className="muted small">Choose books, then type the code on your other phone or computer (or a friend&apos;s). The book goes straight from this device to the other one, with your reading position.</p>
            <div className="voice-list">
              {books.map((b) => (
                <label key={b.id} className={`voice-row${picked.has(b.id) ? " chosen" : ""}`}>
                  <span className="voice-name">
                    <input type="checkbox" checked={picked.has(b.id)} onChange={() => setPicked((p) => toggle(p, b.id))} /> {b.title}
                  </span>
                  <span className="muted small">{b.author ?? ""}</span>
                </label>
              ))}
            </div>
            <button className="btn primary" disabled={!picked.size || busy} onClick={start}>
              Share {picked.size} book{picked.size === 1 ? "" : "s"}
            </button>
          </>
        )}

        {tab === "send" && sharing && (
          <div className="share-code">
            <p className="muted small">On the other device: Voicebook → ⇄ Share → Receive here, and type</p>
            <p className="code">{sharing.code.slice(0, 3)} {sharing.code.slice(3)}</p>
            <p className="muted small">Keep this window open until it&apos;s done.</p>
            <button className="btn" onClick={() => { sharing.stop(); setSharing(null); setStatus(""); }}>Stop sharing</button>
          </div>
        )}

        {tab === "receive" && !offer && (
          <>
            <p className="muted small">On the device that has the book: ⇄ Share → Send from here. Then type the 6-digit code it shows.</p>
            <input className="code-input" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456" value={code}
              onChange={(x) => setCode(x.target.value.replace(/[^\d ]/g, "").slice(0, 7))} />
            <button className="btn primary" disabled={code.replace(/\D/g, "").length !== 6 || busy} onClick={receive}>Connect</button>
          </>
        )}

        {tab === "receive" && offer && (
          <>
            <p className="muted small">{offer.from} is sharing:</p>
            <div className="voice-list">
              {offer.books.map((b) => (
                <label key={b.id} className={`voice-row${offer.pick.has(b.id) ? " chosen" : ""}`}>
                  <span className="voice-name">
                    <input type="checkbox" checked={offer.pick.has(b.id)} onChange={() => setOffer({ ...offer, pick: toggle(offer.pick, b.id) })} /> {b.title}
                  </span>
                  <span className="muted small">{[b.author, `${Math.max(1, Math.round(b.chars / 1500))} pages`].filter(Boolean).join(" · ")}</span>
                </label>
              ))}
            </div>
            <button className="btn primary" disabled={!offer.pick.size} onClick={() => { answer.current?.([...offer.pick]); setOffer(null); setStatus("Receiving…"); }}>
              Get {offer.pick.size} book{offer.pick.size === 1 ? "" : "s"}
            </button>
          </>
        )}

        {status && <p className="small">{status}</p>}
        {error && <p className="error small">{error}</p>}
        <p className="muted small">Only share books you&apos;re allowed to share.</p>
      </div>
    </div>
  );
}
