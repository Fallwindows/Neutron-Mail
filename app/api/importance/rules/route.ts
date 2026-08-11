import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { saveImportanceRules, validateRules } from "@/lib/importance";

export const dynamic = "force-dynamic";
function json(body: unknown, init?: ResponseInit) { const response = NextResponse.json(body, init); response.headers.set("Cache-Control", "no-store"); return response; }

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  let input: unknown;
  try { input = await request.json(); } catch { return json({ error: "Invalid request body." }, { status: 400 }); }
  const rules = validateRules(input, session.email);
  await saveImportanceRules(rules);
  return json({ rules });
}
