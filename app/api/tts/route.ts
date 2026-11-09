import { denied, getAccess, premiumOnly } from "@/lib/access";
import { elevenText, openAIInstructions } from "@/lib/prompts";
import type { TTSRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

async function upstreamError(res: Response, who: string) {
  const detail = (await res.text()).slice(0, 300);
  console.error(who, res.status, detail);
  let msg = `${who} error ${res.status}`;
  if (res.status === 401) msg = `${who}: invalid API key`;
  if (res.status === 429) msg = `${who}: rate limit or quota exceeded`;
  if (/quota|credits|insufficient/i.test(detail)) msg = `${who}: out of credits/quota`;
  return Response.json({ error: msg }, { status: 502 });
}

export async function POST(req: Request) {
  const access = await getAccess(req);
  if (!access.ok) return denied(access);
  if (access.plan !== "premium") return premiumOnly();
  const r = (await req.json().catch(() => null)) as TTSRequest | null;
  if (!r || typeof r.text !== "string" || !r.text.trim())
    return Response.json({ error: "No text" }, { status: 400 });
  r.text = r.text.slice(0, 3000);

  if (r.provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return Response.json({ error: "OPENAI_API_KEY not set" }, { status: 501 });
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
        voice: r.voice || "alloy",
        input: r.text,
        instructions: openAIInstructions(r),
        response_format: "mp3",
      }),
    });
    if (!res.ok) return upstreamError(res, "OpenAI");
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  }

  if (r.provider === "elevenlabs") {
    const key = process.env.ELEVENLABS_API_KEY;
    if (!key) return Response.json({ error: "ELEVENLABS_API_KEY not set" }, { status: 501 });
    const model = process.env.ELEVENLABS_MODEL || "eleven_v3";
    const isV3 = model.includes("v3");
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(r.voice)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({
          text: elevenText(r, isV3),
          model_id: model,
          // v3 stability: 0 = creative, 0.5 = natural, 1 = robust
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );
    if (!res.ok) return upstreamError(res, "ElevenLabs");
    return new Response(res.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  }

  return Response.json({ error: "Unknown provider" }, { status: 400 });
}
