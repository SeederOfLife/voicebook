// Premium: one-shot sound effects generated from a description ("thunder crack").
import { denied, getAccess, premiumOnly } from "@/lib/access";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const access = await getAccess(req);
  if (!access.ok) return denied(access);
  if (access.plan !== "premium") return premiumOnly();
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return Response.json({ error: "Sound effects need ELEVENLABS_API_KEY" }, { status: 501 });

  const body = await req.json().catch(() => null);
  const text = String(body?.text ?? "").trim().slice(0, 120);
  if (!text) return Response.json({ error: "No description" }, { status: 400 });

  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: `${text}, realistic, no music, no speech`,
      model_id: process.env.ELEVENLABS_SFX_MODEL || "eleven_text_to_sound_v3",
      duration_seconds: 3,
      prompt_influence: 0.5,
    }),
  });
  if (!res.ok) {
    console.error("SFX error", res.status, (await res.text()).slice(0, 300));
    return Response.json({ error: `Sound effect failed (${res.status})` }, { status: 502 });
  }
  return new Response(res.body, {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000, immutable" },
  });
}
