import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { withFileLock } from "@/lib/file-lock";
import {
  inboxEmailKey,
  readInboxDraftCache,
  readResponseTaste,
  saveInboxDraftCache,
  tastePrompt,
} from "@/lib/inbox-drafts";
import { getSession } from "@/lib/session";
import { callOpenRouterOnce, getUsageSummary } from "@/lib/openrouter";
import { readVoiceProfile } from "@/lib/voice-profile";
import { inferBaseTone, readTonePreferences } from "@/lib/voice-preferences";
import { readReplyLearning, replyLearningPrompt } from "@/lib/reply-guidance";

export const dynamic = "force-dynamic";
const MAX_EMAIL_CHARS = 12_000;

function json(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function parseAlternatives(content: string) {
  const parsed = JSON.parse(content) as { responses?: unknown };
  if (!Array.isArray(parsed.responses) || parsed.responses.length !== 2) {
    throw new Error("OpenRouter did not return exactly two alternatives.");
  }
  const responses = parsed.responses.map((item) => typeof item === "string" ? item.trim() : "");
  if (responses.some((item) => !item || item.length > 12_000)) {
    throw new Error("OpenRouter returned an invalid alternative response.");
  }
  return responses;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  if (!process.env.OPENROUTER_API_KEY) return json({ error: "OpenRouter is not configured. No model call was made." }, { status: 503 });

  let body: { message_id?: unknown; sender?: unknown; subject?: unknown; email?: unknown; mode?: unknown };
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, { status: 400 }); }
  if (typeof body.message_id !== "string" || !body.message_id || body.message_id.length > 256) return json({ error: "A valid Gmail message ID is required." }, { status: 400 });
  if (body.mode !== "primary" && body.mode !== "alternatives") return json({ error: "mode must be primary or alternatives." }, { status: 400 });
  if (typeof body.email !== "string" || !body.email.trim() || body.email.length > MAX_EMAIL_CHARS) return json({ error: `Email must be between 1 and ${MAX_EMAIL_CHARS.toLocaleString()} characters.` }, { status: 400 });
  const sender = typeof body.sender === "string" ? body.sender.slice(0, 500) : "Unknown sender";
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 500) : "(No subject)";
  const key = inboxEmailKey(session.email, body.message_id);
  const mode = body.mode;

  try {
    await ensureAccountDataDirectory(session.email);
    // One account-wide lock protects the shared cache from lost updates when a user
    // moves between rows while a prior draft is still in flight.
    const result = await withFileLock(accountLockPath(session.email, "inbox_drafts.lock"), async () => {
      const profile = await readVoiceProfile(session.email);
      if (!profile) throw new Error("Build your voice profile before drafting inbox replies.");
      const tone = (await readTonePreferences(session.email))?.vector ?? inferBaseTone(profile.profile);
      const taste = await readResponseTaste(session.email);
      const replyLearning = await readReplyLearning(session.email);
      const cache = await readInboxDraftCache(session.email);
      const entry = cache[key] ?? { owner_email: session.email, email_key: key };
      const existing = entry[mode];
      if (existing?.status === "success") {
        return mode === "primary"
          ? { mode, draft: existing.draft, cached: true }
          : { mode, responses: existing.responses, cached: true };
      }
      if (existing) throw new Error(`This email already used its one allowed ${mode} call. No additional model call was made.${existing.error ? ` ${existing.error}` : ""}`);
      if (mode === "alternatives" && entry.primary?.status !== "success") throw new Error("Generate the primary response before requesting alternatives. No model call was made.");

      entry[mode] = { status: "started", generated_at: new Date().toISOString() };
      cache[key] = entry;
      await saveInboxDraftCache(session.email, cache);

      try {
        const completion = await callOpenRouterOnce({
          model: process.env.OPENROUTER_DRAFT_MODEL ?? "google/gemini-2.5-flash-lite",
          purpose: mode === "primary" ? "inbox_primary_draft" : "inbox_alternatives",
          requestId: `inbox-${mode}-${key}`,
          attempt: 1,
          maxTokens: mode === "primary" ? 1_200 : 2_000,
          jsonOnly: mode === "alternatives",
          messages: [
            { role: "system", content: mode === "primary" ? "Write one send-ready email reply only. Do not explain your work." : "Write exactly two distinct send-ready email replies. Return valid JSON only." },
            {
              role: "user",
              content: mode === "primary"
                ? `Write the most useful reply to this incoming email in the account owner's voice. Preserve facts, do not invent commitments, dates, or details, and do not repeat the incoming message.\n\nVoice profile: ${JSON.stringify(profile.profile)}\nTone radar: ${JSON.stringify(tone)}\n${tastePrompt(taste)}\n${replyLearningPrompt(replyLearning)}\n\nFrom: ${sender}\nSubject: ${subject}\nIncoming email:\n${body.email}`
                : `Write exactly two meaningfully different alternatives to the primary draft below. Both must match the owner's voice and learned taste, preserve facts, and avoid invented commitments. Return exactly {"responses":["...","..."]}.\n\nVoice profile: ${JSON.stringify(profile.profile)}\nTone radar: ${JSON.stringify(tone)}\n${tastePrompt(taste)}\n${replyLearningPrompt(replyLearning)}\n\nFrom: ${sender}\nSubject: ${subject}\nIncoming email:\n${body.email}\n\nPrimary draft:\n${entry.primary?.draft ?? ""}`,
            },
          ],
        });
        if (mode === "primary") {
          const draft = completion.content.trim();
          if (!draft) throw new Error("OpenRouter returned an empty draft.");
          entry.primary = { status: "success", generated_at: new Date().toISOString(), draft };
          await saveInboxDraftCache(session.email, cache);
          return { mode, draft, cached: false };
        }
        const responses = parseAlternatives(completion.content);
        entry.alternatives = { status: "success", generated_at: new Date().toISOString(), responses };
        await saveInboxDraftCache(session.email, cache);
        return { mode, responses, cached: false };
      } catch (error) {
        entry[mode] = { status: "error", generated_at: new Date().toISOString(), error: error instanceof Error ? error.message : "Draft generation failed." };
        await saveInboxDraftCache(session.email, cache);
        throw error;
      }
    });
    return json({ ...result, usage: await getUsageSummary() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Inbox draft generation failed." }, { status: 400 });
  }
}
