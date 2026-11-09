"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
export function getSupabase(url: string, anonKey: string) {
  client ??= createClient(url, anonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: "pkce" } });
  return client;
}
