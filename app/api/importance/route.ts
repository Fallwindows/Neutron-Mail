import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUsageSummary } from "@/lib/openrouter";
import { readGoalsProfile, readImportanceInstructions, readImportanceRules } from "@/lib/importance";

export const dynamic = "force-dynamic";
function json(body: unknown, init?: ResponseInit) { const response = NextResponse.json(body, init); response.headers.set("Cache-Control", "no-store"); return response; }

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  const [profile, rules, instructions, usage] = await Promise.all([readGoalsProfile(session.email), readImportanceRules(session.email), readImportanceInstructions(session.email), getUsageSummary()]);
  return json({ profile, rules, instructions, usage, configured: Boolean(process.env.OPENROUTER_API_KEY) });
}
