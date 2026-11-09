// Stripe → keeps profiles.plan in sync with the subscription.
// In Stripe: Developers → Webhooks → add endpoint https://YOUR-APP.vercel.app/api/stripe-webhook
// Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/access";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whsec) return new Response("Billing not configured", { status: 501 });
  const stripe = new Stripe(secret);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(await req.text(), req.headers.get("stripe-signature") ?? "", whsec);
  } catch (e) {
    return new Response(`Bad signature: ${(e as Error).message}`, { status: 400 });
  }

  const sb = supabaseAdmin();
  const setPlan = async (userId: string | undefined | null, fields: Record<string, unknown>) => {
    if (!userId) return;
    await sb.from("profiles").upsert({ id: userId, ...fields, updated_at: new Date().toISOString() });
  };

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      await setPlan(s.client_reference_id ?? s.metadata?.user_id, {
        plan: "premium",
        stripe_customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id,
      });
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const active = event.type === "customer.subscription.updated" && ["active", "trialing", "past_due"].includes(sub.status);
      await setPlan(sub.metadata?.user_id, { plan: active ? "premium" : "free" });
      break;
    }
  }
  return Response.json({ received: true });
}
