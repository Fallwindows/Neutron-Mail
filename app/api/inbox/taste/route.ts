import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { withFileLock } from "@/lib/file-lock";
import { readResponseTaste, saveResponseTaste } from "@/lib/inbox-drafts";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
function json(body: unknown, init?: ResponseInit) { const response = NextResponse.json(body, init); response.headers.set("Cache-Control", "no-store"); return response; }

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  const taste = await readResponseTaste(session.email);
  return json({ preferences: taste?.preferences ?? null, decisions: Object.keys(taste?.decisions ?? {}).length, updated_at: taste?.updated_at ?? null });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  let body: { message_id?: unknown; text?: unknown; source?: unknown };
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, { status: 400 }); }
  if (typeof body.message_id !== "string" || !body.message_id || body.message_id.length > 256) return json({ error: "A valid Gmail message ID is required." }, { status: 400 });
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 12_000) return json({ error: "The final response must be between 1 and 12,000 characters." }, { status: 400 });
  if (body.source !== "generated" && body.source !== "edited") return json({ error: "source must be generated or edited." }, { status: 400 });
  try {
    await ensureAccountDataDirectory(session.email);
    const taste = await withFileLock(accountLockPath(session.email, "response_taste.lock"), () => saveResponseTaste({ ownerEmail: session.email, messageId: body.message_id as string, text: (body.text as string).trim(), source: body.source as "generated" | "edited" }));
    return json({ preferences: taste.preferences, decisions: Object.keys(taste.decisions).length, updated_at: taste.updated_at, persisted: "Derived metrics and a response hash only; raw final response text was not stored." });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Could not save response taste." }, { status: 400 }); }
}
