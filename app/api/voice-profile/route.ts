import { appendFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { getSession } from "@/lib/session";
import { resolveGoogleAccessToken } from "@/lib/google-connection";
import { buildVoiceProfilePrompt, fetchSentEmailSamples } from "@/lib/gmail";
import { withFileLock } from "@/lib/file-lock";
import { callOpenRouterOnce, getUsageSummary } from "@/lib/openrouter";
import {
  rawVoiceFailureLogPath,
  readVoiceProfile,
  saveVoiceProfile,
  validateVoiceProfile,
} from "@/lib/voice-profile";

export const dynamic = "force-dynamic";

function noStore<T>(body: T, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET() {
  const session = await getSession();
  if (!session) return noStore({ error: "Not signed in." }, { status: 401 });
  return noStore({ profile: await readVoiceProfile(session.email), usage: await getUsageSummary(), configured: Boolean(process.env.OPENROUTER_API_KEY) });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return noStore({ error: "Not signed in." }, { status: 401 });
  if (!process.env.OPENROUTER_API_KEY) {
    return noStore({ error: "OPENROUTER_API_KEY is not configured. No Gmail data was fetched and no model call was made." }, { status: 503 });
  }

  let body: { access_token?: unknown; refresh?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStore({ error: "Invalid request body." }, { status: 400 });
  }
  if (body.access_token !== undefined && (typeof body.access_token !== "string" || body.access_token.length > 4096)) {
    return noStore({ error: "A valid Gmail access token is required." }, { status: 400 });
  }

  try {
    const accessToken = await resolveGoogleAccessToken(session.email, body.access_token);
    await ensureAccountDataDirectory(session.email);
    const result = await withFileLock(accountLockPath(session.email, "voice_profile.lock"), async () => {
      const current = await readVoiceProfile(session.email);
      if (current && body.refresh !== true) {
        throw new Error("A cached profile already exists. Use the explicit refresh action to regenerate it.");
      }

      const samples = await fetchSentEmailSamples(accessToken, session.email);
      if (samples.length === 0) throw new Error("No usable sent emails were found.");

      const model = process.env.OPENROUTER_PROFILE_MODEL ?? "google/gemini-2.5-flash-lite";
      const requestId = `voice-profile-${Date.now()}`;
      const completion = await callOpenRouterOnce({
        model,
        purpose: "voice_profile",
        requestId,
        attempt: 1,
        maxTokens: 900,
        jsonOnly: true,
        messages: [
          { role: "system", content: "You are a precise writing-style analyst. Output valid JSON only." },
          { role: "user", content: buildVoiceProfilePrompt(samples) },
        ],
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(completion.content);
      } catch {
        await ensureAccountDataDirectory(session.email);
        await appendFile(
          rawVoiceFailureLogPath(session.email),
          `${new Date().toISOString()} ${requestId}\n${completion.content}\n---\n`,
          "utf8",
        );
        throw new Error("OpenRouter returned invalid JSON. The raw response was logged locally; no automatic retry was made.");
      }

      const stored = {
        owner_email: session.email,
        generated_at: new Date().toISOString(),
        sampled_emails: samples.length,
        profile: validateVoiceProfile(parsed),
      };
      await saveVoiceProfile(stored);
      return stored;
    });
    return noStore({ profile: result, usage: await getUsageSummary() });
  } catch (error) {
    return noStore({ error: error instanceof Error ? error.message : "Profile generation failed." }, { status: 400 });
  }
}
