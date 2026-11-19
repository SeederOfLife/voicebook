"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReaderEngine } from "@/lib/engine";
import { library, type BookSummary } from "@/lib/library";
import type { NativeStorage } from "@/lib/native";
import { TIERS } from "@/lib/builtin";

const size = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`;

/**
 * 🧹 Storage & speed: what Voicebook takes on this device, and honest ways to free space
 * and memory. (Android doesn't let any app clean other apps; the phone's own storage
 * screen is one tap away.)
 */
export function StoragePanel({ e, books, onClose, onChanged }: { e: ReaderEngine; books: BookSummary[]; onClose: () => void; onChanged: () => void }) {
  const [audio, setAudio] = useState<Map<string, { count: number; bytes: number }>>(new Map());
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number }>({});
  const [phone, setPhone] = useState<NativeStorage | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const measure = useCallback(async () => {
    setAudio(await library.audioStats());
    try {
      setEstimate(await navigator.storage.estimate());
    } catch {}
    setPhone(e.native.storageInfo());
  }, [e]);

  useEffect(() => {
    void measure();
    const t = setInterval(() => setPhone(e.native.storageInfo()), 3000); // after "allow background" etc.
    return () => clearInterval(t);
  }, [measure, e]);

  const say = async (msg: string) => {
    setDone(msg);
    await measure();
    onChanged();
  };

  const audioTotal = [...audio.values()].reduce((a, s) => a + s.bytes, 0);
  const progress = (b: BookSummary) => b.position.chunk / Math.max(1, b.total);
  const finished = books.filter((b) => progress(b) >= 0.98 && (audio.get(b.id)?.bytes ?? 0) > 0);
  const biggest = books
    .map((b) => ({ b, s: audio.get(b.id) }))
    .filter((x) => x.s && x.s.bytes > 0)
    .sort((a, b) => b.s!.bytes - a.s!.bytes)
    .slice(0, 6);
  const webVoices = [...e.builtin.stored].filter((t) => !(e.provider === "builtin" && e.builtin.tier === t));

  return (
    <div className="modal-bg sheet-bg" onClick={onClose}>
      <div className="card modal voice-sheet" onClick={(x) => x.stopPropagation()} role="dialog" aria-label="Storage and speed">
        <div className="row between">
          <h3>🧹 Storage & speed</h3>
          <button className="icon small-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="storage-grid small">
          <span>Saved audio</span>
          <strong>{size(audioTotal)}</strong>
          {estimate.usage !== undefined && (
            <>
              <span>Voicebook in this browser</span>
              <strong>{size(estimate.usage)}</strong>
            </>
          )}
          {phone && (
            <>
              <span>Phone voices</span>
              <strong>{size(phone.voicesBytes)}</strong>
              <span>Temporary files</span>
              <strong>{size(phone.cacheBytes)}</strong>
              <span>Free space on the phone</span>
              <strong className={phone.freeBytes < 2e9 ? "warn" : ""}>
                {size(phone.freeBytes)} of {size(phone.totalBytes)}
              </strong>
              <span>Free memory on the phone</span>
              <strong className={phone.phoneMemoryLow ? "warn" : ""}>{phone.phoneMemoryFreeMb} MB{phone.phoneMemoryLow ? " (low)" : ""}</strong>
            </>
          )}
        </div>

        {done && <p className="tip small">✓ {done}</p>}

        <h4 className="section-label">Free space</h4>
        <div className="clean-actions">
          {finished.length > 0 && (
            <button className="btn" onClick={async () => {
              for (const b of finished) await library.clearAudio(b.id);
              await say(`Removed the saved audio of ${finished.length} finished book${finished.length > 1 ? "s" : ""}.`);
            }}>
              Remove saved audio of finished books ({size(finished.reduce((a, b) => a + (audio.get(b.id)?.bytes ?? 0), 0))})
            </button>
          )}
          {audioTotal > 0 && (
            <button className="btn" onClick={async () => {
              if (!confirm("Remove all saved audio? Passages will be made again when you listen.")) return;
              for (const id of audio.keys()) await library.clearAudio(id);
              e.clearSavedAudio?.();
              await say("All saved audio removed.");
            }}>
              Remove all saved audio ({size(audioTotal)})
            </button>
          )}
          {webVoices.length > 0 && (
            <button className="btn" onClick={async () => {
              await e.builtin.deleteDownloads();
              await say("Downloaded on-device voices removed.");
            }}>
              Remove on-device voices ({webVoices.map((t) => `${TIERS[t].name} ${TIERS[t].mb} MB`).join(", ")})
            </button>
          )}
          {phone && (["fast", "best"] as const).filter((t) => e.native.status(t)?.ready && !(e.native.tier === t)).map((t) => (
            <button key={t} className="btn" onClick={async () => {
              e.native.remove(t);
              setTimeout(() => void say(`The ${t === "best" ? "Best" : "Fast"} phone voice was removed.`), 800);
            }}>
              Remove the unused {t === "best" ? "Best (350 MB)" : "Fast (132 MB)"} phone voice
            </button>
          ))}
          {phone && phone.cacheBytes > 0 && (
            <button className="btn" onClick={() => {
              e.native.clearCache();
              setTimeout(() => void say("Temporary files cleared."), 800);
            }}>
              Clear temporary files ({size(phone.cacheBytes)})
            </button>
          )}
        </div>
        {biggest.length > 0 && (
          <details className="small">
            <summary>Saved audio by book</summary>
            {biggest.map(({ b, s }) => (
              <div key={b.id} className="row between">
                <span>{b.title} <span className="muted">· {s!.count} passages</span></span>
                <button className="link-btn" onClick={async () => { await library.clearAudio(b.id); await say(`Saved audio of “${b.title}” removed.`); }}>
                  Remove {size(s!.bytes)}
                </button>
              </div>
            ))}
          </details>
        )}

        <h4 className="section-label">Speed</h4>
        <div className="clean-actions">
          <button className="btn" onClick={() => { e.freeMemory(); void say("Memory freed: voices that weren't in use were closed."); }}>
            Free memory now
          </button>
          {phone && !phone.backgroundAllowed && (
            <button className="btn primary" onClick={() => e.native.allowBackground()}>
              Let Voicebook keep reading in the background
            </button>
          )}
          {phone?.backgroundAllowed && <p className="muted small">✓ Android lets Voicebook keep reading in the background.</p>}
          {phone && (
            <button className="btn" onClick={() => e.native.openStorageSettings()}>
              Free up space on the rest of the phone (Android)
            </button>
          )}
        </div>
        <p className="muted small">
          Your books themselves are never removed here. Android doesn&apos;t let apps clean other apps; its own “Free up space” screen does that safely.
        </p>
      </div>
    </div>
  );
}
