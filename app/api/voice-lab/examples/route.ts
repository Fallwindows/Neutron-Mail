import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { getSession } from "@/lib/session";
import { withFileLock } from "@/lib/file-lock";
import { callOpenRouterOnce, getUsageSummary } from "@/lib/openrouter";
import { readVoiceProfile } from "@/lib/voice-profile";
import {
  inferBaseTone,
  readTonePreferences,
  readVoiceExampleCache,
  saveVoiceExampleCache,
  voiceExampleKey,
} from "@/lib/voice-preferences";
import { readResponseTaste, tastePrompt } from "@/lib/inbox-drafts";

const MAX_EMAIL_CHARS = 8_000;

function json(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function parseResponses(content: string) {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const keys = ["direct", "warm", "polished"] as const;
  for (const key of keys) {
    if (typeof parsed[key] !== "string" || !parsed[key].trim()) {
      throw new Error(`OpenRouter response is missing the ${key} example.`);
    }
  }
  return [
    { id: "direct" as const, label: "Clear & direct", description: "Decisive, concise, action-first", email: (parsed.direct as string).trim() },
    { id: "warm" as const, label: "Warm & human", description: "Personal, open, relationship-first", email: (parsed.warm as string).trim() },
    { id: "polished" as const, label: "Polished & precise", description: "Structured, considered, professional", email: (parsed.polished as string).trim() },
  ];
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  if (!process.env.OPENROUTER_API_KEY) {
    return json({ error: "OpenRouter is not configured. No model call was made." }, { status: 503 });
  }

  let body: { message_id?: unknown; from?: unknown; subject?: unknown; email?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof body.message_id !== "string" || !body.message_id || body.message_id.length > 256) {
    return json({ error: "A valid Gmail message ID is required." }, { status: 400 });
  }
  if (typeof body.email !== "string" || !body.email.trim() || body.email.length > MAX_EMAIL_CHARS) {
    return json({ error: `Email must be between 1 and ${MAX_EMAIL_CHARS.toLocaleString()} characters.` }, { status: 400 });
  }
  const from = typeof body.from === "string" ? body.from.slice(0, 500) : "Unknown sender";
  const subject = typeof body.subject === "string" ? body.subject.slice(0, 500) : "(No subject)";
  const key = voiceExampleKey(session.email, body.message_id);

  try {
    await ensureAccountDataDirectory(session.email);
    const result = await withFileLock(accountLockPath(session.email, "voice_examples.lock"), async () => {
      const profile = await readVoiceProfile(session.email);
      if (!profile) {
        throw new Error("Build a voice profile before generating examples.");
      }
      const preferences = await readTonePreferences(session.email);
      const toneVector = preferences?.vector ?? inferBaseTone(profile.profile);
      const taste = await readResponseTaste(session.email);
      const cache = await readVoiceExampleCache(session.email);
      const existing = cache[key];
      if (existing?.owner_email.toLowerCase() === session.email.toLowerCase()) {
        if (existing.responses) return { email_key: key, responses: existing.responses, cached: true, tone_vector: toneVector };
        throw new Error("This email already used its one allowed example-generation call. No additional call was made.");
      }

      const requestId = `voice-examples-${key}`;
      try {
        const completion = await callOpenRouterOnce({
          model: process.env.OPENROUTER_DRAFT_MODEL ?? "google/gemini-2.5-flash-lite",
          purpose: "voice_examples",
          requestId,
          attempt: 1,
          maxTokens: 2_400,
          jsonOnly: true,
          messages: [
            {
              role: "system",
              content: "Write exactly three distinct email replies. Return valid JSON only and do not explain your work.",
            },
            {
              role: "user",
              content: `Draft three plausible replies to the email below, all authentically matching the sender's cached writing profile and current tone preferences. The direct version should be concise and action-first. The warm version should be personal and relationship-first. The polished version should be structured and professional. Preserve facts; do not invent commitments, dates, or details. Do not repeat the incoming email. Return exactly {"direct":"...","warm":"...","polished":"..."}.\n\nCached writing profile:\n${JSON.stringify(profile.profile)}\n\nCurrent tone radar (0-100):\n${JSON.stringify(toneVector)}\n${tastePrompt(taste)}\n\nFrom: ${from}\nSubject: ${subject}\nIncoming email:\n${body.email}`,
            },
          ],
        });
        const responses = parseResponses(completion.content);
        cache[key] = {
          owner_email: session.email,
          email_key: key,
          generated_at: new Date().toISOString(),
          responses,
        };
        await saveVoiceExampleCache(session.email, cache);
        return { email_key: key, responses, cached: false, tone_vector: toneVector };
      } catch (error) {
        cache[key] = {
          owner_email: session.email,
          email_key: key,
          generated_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Example generation failed.",
        };
        await saveVoiceExampleCache(session.email, cache);
        throw error;
      }
    });
    return json({ ...result, usage: await getUsageSummary() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Example generation failed." }, { status: 400 });
  }
}
