// Starts a Stripe Checkout for the Premium subscription.
import Stripe from "stripe";
import { denied, getAccess, supabaseAdmin } from "@/lib/access";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const a = await getAccess(req);
  if (!a.ok || !a.user) return denied(a);
  const secret = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  if (!secret || !price) return Response.json({ error: "Billing is not set up yet" }, { status: 501 });

  const stripe = new Stripe(secret);
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const { data: profile } = await supabaseAdmin()
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", a.user.id)
    .maybeSingle();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: a.user.id,
    customer: profile?.stripe_customer_id || undefined,
    customer_email: profile?.stripe_customer_id ? undefined : a.user.email,
    metadata: { user_id: a.user.id },
    subscription_data: { metadata: { user_id: a.user.id } },
    allow_promotion_codes: true,
    success_url: `${origin}/?upgraded=1`,
    cancel_url: `${origin}/`,
  });
  return Response.json({ url: session.url });
}
