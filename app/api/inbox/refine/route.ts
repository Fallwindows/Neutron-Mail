import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { withFileLock } from "@/lib/file-lock";
import { readGoalsProfile } from "@/lib/importance";
import { readResponseTaste, tastePrompt } from "@/lib/inbox-drafts";
import { callOpenRouterOnce, getUsageSummary } from "@/lib/openrouter";
import { readReplyLearning, replyLearningPrompt, saveReplyLearning } from "@/lib/reply-guidance";
import { getSession } from "@/lib/session";
import { readVoiceProfile } from "@/lib/voice-profile";
import { inferBaseTone, readTonePreferences } from "@/lib/voice-preferences";

export const dynamic = "force-dynamic";
const MAX_EMAIL_CHARS = 12_000;
const MAX_INSTRUCTION_CHARS = 600;

function json(body: unknown, init?: ResponseInit) { const response = NextResponse.json(body, init); response.headers.set("Cache-Control", "no-store"); return response; }

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  if (!process.env.OPENROUTER_API_KEY) return json({ error: "OpenRouter is not configured. No model call was made." }, { status: 503 });
  let body: { message_id?: unknown; sender?: unknown; subject?: unknown; email?: unknown; instruction?: unknown };
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, { status: 400 }); }
  if (typeof body.message_id !== "string" || !body.message_id || body.message_id.length > 256) return json({ error: "A valid Gmail message ID is required." }, { status: 400 });
  if (typeof body.email !== "string" || !body.email.trim() || body.email.length > MAX_EMAIL_CHARS) return json({ error: `Email must be between 1 and ${MAX_EMAIL_CHARS.toLocaleString()} characters.` }, { status: 400 });
  if (typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.length > MAX_INSTRUCTION_CHARS) return json({ error: `Your quick reply must be between 1 and ${MAX_INSTRUCTION_CHARS} characters.` }, { status: 400 });
  const messageId = body.message_id;
  const incomingEmail = body.email;
  const instruction = body.instruction.trim();
  const sender = typeof body.sender === "string" ? body.sender.slice(0, 500) : "Unknown sender";
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 500) : "(No subject)";
  try {
    await ensureAccountDataDirectory(session.email);
    const result = await withFileLock(accountLockPath(session.email, "reply_guidance.lock"), async () => {
      const [profile, toneStored, taste, goals, learning] = await Promise.all([readVoiceProfile(session.email), readTonePreferences(session.email), readResponseTaste(session.email), readGoalsProfile(session.email), readReplyLearning(session.email)]);
      if (!profile) throw new Error("Build your voice profile before rewriting inbox replies.");
      const tone = toneStored?.vector ?? inferBaseTone(profile.profile);
      const completion = await callOpenRouterOnce({
        model: process.env.OPENROUTER_DRAFT_MODEL ?? "google/gemini-2.5-flash-lite",
        purpose: "inbox_guided_reply",
        requestId: `inbox-guided-${createHash("sha256").update(session.email).update("\0").update(messageId).update("\0").update(instruction).update("\0").update(String(Date.now())).digest("hex")}`,
        attempt: 1,
        maxTokens: 1_200,
        messages: [
          { role: "system", content: "Turn the owner's rough reply intent into one send-ready email. Return only the email, with no explanation." },
          { role: "user", content: `The owner's quick reply below is authoritative. Preserve its meaning and facts exactly, but rewrite it as a polished email in the owner's saved voice. Do not add commitments, dates, names, claims, or decisions that the owner did not provide. Use the incoming message only to make the reply coherent.\n\nOwner's quick reply:\n${instruction}\n\nVoice profile: ${JSON.stringify(profile.profile)}\nTone radar: ${JSON.stringify(tone)}\n${tastePrompt(taste)}\nAccount goals context (use for alignment only, never invent facts): ${JSON.stringify(goals?.profile ?? null)}\n${replyLearningPrompt(learning)}\n\nFrom: ${sender}\nSubject: ${subject}\nIncoming email:\n${incomingEmail}` },
        ],
      });
      const draft = completion.content.trim();
      if (!draft || draft.length > 12_000) throw new Error("OpenRouter returned an invalid rewritten reply.");
      const saved = await saveReplyLearning({ ownerEmail: session.email, messageId, instruction, draft });
      return { draft, learning_count: saved.learnings.length, learned_at: saved.updated_at };
    });
    return json({ ...result, usage: await getUsageSummary() });
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Could not rewrite this reply." }, { status: 400 }); }
}
