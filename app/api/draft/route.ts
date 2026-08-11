import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { getSession } from "@/lib/session";
import { withFileLock } from "@/lib/file-lock";
import { callOpenRouterOnce, getUsageSummary } from "@/lib/openrouter";
import { readVoiceProfile } from "@/lib/voice-profile";
import { draftKey, readDraftCache, saveDraftCache } from "@/lib/draft-cache";
import { inferBaseTone, readTonePreferences } from "@/lib/voice-preferences";
import { readResponseTaste, tastePrompt } from "@/lib/inbox-drafts";

const MAX_DRAFT_ATTEMPTS = 2;

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY is not configured. No model call was made." }, { status: 503 });
  }

  let body: { original_email?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof body.original_email !== "string" || !body.original_email.trim() || body.original_email.length > 50_000) {
    return NextResponse.json({ error: "original_email must be between 1 and 50,000 characters." }, { status: 400 });
  }
  if (body.context !== undefined && (typeof body.context !== "string" || body.context.length > 50_000)) {
    return NextResponse.json({ error: "context must be at most 50,000 characters." }, { status: 400 });
  }

  const context = typeof body.context === "string" ? body.context : "";
  const originalEmail = body.original_email;

  try {
    await ensureAccountDataDirectory(session.email);
    const result = await withFileLock(accountLockPath(session.email, "draft_cache.lock"), async () => {
      const profile = await readVoiceProfile(session.email);
      if (!profile) {
        throw new Error("Build a voice profile before drafting.");
      }
      const storedPreferences = await readTonePreferences(session.email);
      const tonePreferences = storedPreferences?.vector ?? inferBaseTone(profile.profile);
      const taste = await readResponseTaste(session.email);
      const preferenceVersion = `${storedPreferences?.updated_at ?? profile.generated_at}:${taste?.updated_at ?? "no-taste"}`;
      const key = draftKey(
        session.email,
        originalEmail,
        `${context}\n\nTone preference version: ${preferenceVersion}`,
      );

      const cache = await readDraftCache(session.email);
      const existing = cache[key];
      if (existing?.draft) return { draft: existing.draft, cached: true };
      if ((existing?.attempts ?? 0) >= MAX_DRAFT_ATTEMPTS) {
        throw new Error("The two-attempt cap for this email has been reached. No additional call was made.");
      }

      const model = process.env.OPENROUTER_DRAFT_MODEL ?? "google/gemini-2.5-flash-lite";
      let lastError = "Draft generation failed.";
      const startAttempt = (existing?.attempts ?? 0) + 1;

      for (let attempt = startAttempt; attempt <= MAX_DRAFT_ATTEMPTS; attempt += 1) {
        cache[key] = { attempts: attempt };
        await saveDraftCache(session.email, cache);
        try {
          const response = await callOpenRouterOnce({
            model,
            purpose: "draft",
            requestId: `draft-${key}`,
            attempt,
            maxTokens: 1200,
            messages: [
              { role: "system", content: "Write one email reply only. Do not explain your work." },
              {
                role: "user",
                content: `Write a reply in this person's voice, matching this immutable style profile: ${JSON.stringify(profile.profile)}. Apply this learned tone preference overlay (0-100): ${JSON.stringify(tonePreferences)}. ${tastePrompt(taste)} The overlays refine delivery but must not contradict facts or invent commitments.\n\nOriginal email:\n${originalEmail}\n\nRelevant thread context:\n${context || "None provided."}`,
              },
            ],
          });
          cache[key] = { attempts: attempt, draft: response.content.trim(), created_at: new Date().toISOString() };
          await saveDraftCache(session.email, cache);
          return { draft: cache[key].draft as string, cached: false };
        } catch (error) {
          lastError = error instanceof Error ? error.message : lastError;
          cache[key] = { attempts: attempt, last_error: lastError };
          await saveDraftCache(session.email, cache);
        }
      }
      throw new Error(`${lastError} The one automatic retry was used; no further call will be made for this email.`);
    });
    return NextResponse.json({ ...result, usage: await getUsageSummary() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Draft generation failed." }, { status: 400 });
  }
}
