// Server-side access control.
//
// Two modes:
//  • "open"     – the default. Every feature (AI voices, accents, sound
//                 effects, ambience, music) is unlocked for everyone, with no
//                 sign-in. Optionally protected with APP_PASSWORD.
//  • "accounts" – only when PAYWALL=on and Supabase is configured. Visitors
//                 sign in; their plan ("free" | "premium") lives in the
//                 `profiles` table and is set by the Stripe webhook.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Plan } from "./types";

export interface Access {
  ok: boolean;
  status: number;
  mode: "open" | "accounts";
  plan: Plan;
  user: { id: string; email: string } | null;
  passwordRequired: boolean;
}

export const accountsEnabled = () =>
  process.env.PAYWALL === "on" &&
  !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);

let admin: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  admin ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}

const premiumEmails = () =>
  (process.env.PREMIUM_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export async function getAccess(req: Request): Promise<Access> {
  const pw = process.env.APP_PASSWORD;
  const passwordOk = !pw || req.headers.get("x-app-password") === pw;

  if (!accountsEnabled()) {
    return {
      ok: passwordOk,
      status: passwordOk ? 200 : 401,
      mode: "open",
      plan: "premium",
      user: null,
      passwordRequired: !!pw,
    };
  }

  const base: Access = { ok: false, status: 401, mode: "accounts", plan: "free", user: null, passwordRequired: false };
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return base;
  const sb = supabaseAdmin();
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return base;
  const user = { id: data.user.id, email: data.user.email ?? "" };

  let plan: Plan = "free";
  if (premiumEmails().includes(user.email.toLowerCase())) plan = "premium";
  else {
    const { data: profile } = await sb.from("profiles").select("plan").eq("id", user.id).maybeSingle();
    if (profile?.plan === "premium") plan = "premium";
  }
  return { ok: true, status: 200, mode: "accounts", plan, user, passwordRequired: false };
}

export function denied(a: Access) {
  return Response.json(
    { error: a.mode === "accounts" ? "Please sign in" : "Password required" },
    { status: a.status || 401 },
  );
}

export function premiumOnly() {
  return Response.json({ error: "This is a Premium feature — upgrade to unlock it.", premium: true }, { status: 402 });
}
