// The studio voice: studio-quality speech generated on the server, so it works on
// every device (phones included) with no API key.
//
//   POST { text, voice?, speed?, tailMs? }  → audio/mpeg
//   POST { warm: true }                     → loads the voice model, returns its status
//   GET                                     → status (for troubleshooting)
//   GET ?test=1                             → loads the model, speaks one sentence, reports how it went
import { denied, getAccess } from "@/lib/access";
import { encodeMp3, encodeWav } from "@/lib/studio/encode";
import { SAMPLE_RATE, studioStatus, synthesize, warmUp } from "@/lib/studio/kokoro";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Tells apart the server instances that answer (useful when several run in parallel). */
const INSTANCE = Math.random().toString(36).slice(2, 8);
const MAX_CHARS = 1500;

const enabled = () => process.env.STUDIO_VOICE !== "off";

/** Only this site's own pages may ask for speech (it costs server time). */
function fromThisSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

function statusBody() {
  return { enabled: enabled(), instance: INSTANCE, ...studioStatus() };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.has("test")) return Response.json(statusBody(), { headers: { "cache-control": "no-store" } });

  // Self-test: open /api/voice?test=1 in a browser to see whether the studio voice works here.
  if (!enabled()) return Response.json({ ok: false, error: "The studio voice is switched off on this server." }, { status: 501 });
  const password = process.env.APP_PASSWORD;
  if (password && url.searchParams.get("password") !== password) {
    return Response.json({ ok: false, error: "Add ?password=… to run the test on this private app." }, { status: 401 });
  }
  try {
    const started = Date.now();
    const result = await synthesize("The studio voice is working.", { tailMs: 100 });
    const mp3 = await encodeMp3(result.audio, SAMPLE_RATE);
    return Response.json(
      {
        ...statusBody(),
        ok: true,
        audioSeconds: Number(result.seconds.toFixed(2)),
        generatedInSeconds: Number(result.took.toFixed(2)),
        totalSecondsIncludingLoading: Number(((Date.now() - started) / 1000).toFixed(1)),
        mp3Bytes: mp3.byteLength,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ ...statusBody(), ok: false, error: message }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export async function POST(req: Request) {
  if (!enabled()) return Response.json({ error: "The studio voice is switched off on this server." }, { status: 501 });
  if (!fromThisSite(req)) return Response.json({ error: "Not allowed from another site." }, { status: 403 });
  const access = await getAccess(req);
  if (!access.ok) return denied(access);

  const body = (await req.json().catch(() => null)) as
    | { text?: unknown; voice?: unknown; speed?: unknown; tailMs?: unknown; warm?: unknown; format?: unknown }
    | null;
  if (!body) return Response.json({ error: "Bad request" }, { status: 400 });

  try {
    if (body.warm) {
      await warmUp();
      return Response.json(statusBody(), { headers: { "cache-control": "no-store" } });
    }

    const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_CHARS) : "";
    if (!text) return Response.json({ error: "No text" }, { status: 400 });

    const cpu = process.cpuUsage();
    const result = await synthesize(text, {
      voice: typeof body.voice === "string" ? body.voice : undefined,
      speed: Number(body.speed) || 1,
      tailMs: Number.isFinite(Number(body.tailMs)) ? Number(body.tailMs) : 300,
    });
    const wav = body.format === "wav";
    const audio = wav ? encodeWav(result.audio, SAMPLE_RATE) : await encodeMp3(result.audio, SAMPLE_RATE);
    const used = process.cpuUsage(cpu);

    return new Response(audio as BodyInit, {
      headers: {
        "content-type": wav ? "audio/wav" : "audio/mpeg",
        "content-length": String(audio.byteLength),
        "cache-control": "no-store",
        "x-audio-seconds": result.seconds.toFixed(2),
        "x-took-seconds": result.took.toFixed(2),
        "x-cpu-seconds": ((used.user + used.system) / 1e6).toFixed(2),
        "x-voice-model": studioStatus().variant ?? "",
        "x-instance": INSTANCE,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[studio voice]", message);
    return Response.json({ error: `The studio voice couldn't start: ${message}`, status: statusBody() }, { status: 503 });
  }
}
