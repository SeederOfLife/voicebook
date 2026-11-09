// Opens the Stripe customer portal (cancel / change card).
import Stripe from "stripe";
import { denied, getAccess, supabaseAdmin } from "@/lib/access";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const a = await getAccess(req);
  if (!a.ok || !a.user) return denied(a);
  if (!process.env.STRIPE_SECRET_KEY) return Response.json({ error: "Billing is not set up" }, { status: 501 });
  const { data: profile } = await supabaseAdmin()
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", a.user.id)
    .maybeSingle();
  if (!profile?.stripe_customer_id) return Response.json({ error: "No subscription found" }, { status: 404 });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${origin}/`,
  });
  return Response.json({ url: session.url });
}
