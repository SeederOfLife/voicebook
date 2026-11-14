import { getAccess } from "@/lib/access";
import type { AppConfig, VoiceOption } from "@/lib/types";
import { ELEVENLABS_FALLBACK_VOICES, OPENAI_VOICES } from "@/lib/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function elevenVoices(key: string): Promise<VoiceOption[]> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const list: VoiceOption[] = (data.voices ?? []).map((v: any) => ({
      id: v.voice_id,
      name: [v.name, v.labels?.accent, v.labels?.age].filter(Boolean).join(" · "),
      gender: v.labels?.gender === "male" ? "male" : v.labels?.gender === "female" ? "female" : "neutral",
      useCase: v.labels?.use_case ?? v.labels?.["use case"] ?? v.description ?? "",
    }));
    return list.length ? list : ELEVENLABS_FALLBACK_VOICES;
  } catch {
    return ELEVENLABS_FALLBACK_VOICES;
  }
}

export async function GET(req: Request) {
  const a = await getAccess(req);
  const ekey = process.env.ELEVENLABS_API_KEY;
  const premium = a.ok && a.plan === "premium";
  const config: AppConfig = {
    providers: {
      // The studio voice runs on this server itself: no key needed.
      studio: process.env.STUDIO_VOICE !== "off",
      elevenlabs: !!ekey,
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
    },
    studioMonthlyHours: Number.isFinite(Number(process.env.STUDIO_MONTHLY_HOURS)) && process.env.STUDIO_MONTHLY_HOURS !== undefined && process.env.STUDIO_MONTHLY_HOURS !== ""
      ? Math.max(0, Number(process.env.STUDIO_MONTHLY_HOURS))
      : 3,
    passwordRequired: a.passwordRequired,
    authorized: a.ok,
    mode: a.mode,
    plan: a.ok ? a.plan : "free",
    user: a.user ? { email: a.user.email } : null,
    supabase:
      a.mode === "accounts"
        ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL!, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! }
        : null,
    billing: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    voices: {
      openai: OPENAI_VOICES,
      elevenlabs: ekey && premium ? await elevenVoices(ekey) : [],
    },
  };
  return Response.json(config);
}
