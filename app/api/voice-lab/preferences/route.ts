import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { getSession } from "@/lib/session";
import { withFileLock } from "@/lib/file-lock";
import { readVoiceProfile } from "@/lib/voice-profile";
import {
  inferBaseTone,
  isResponseStyle,
  readTonePreferences,
  readVoiceExampleCache,
  saveToneSelection,
} from "@/lib/voice-preferences";

export const dynamic = "force-dynamic";

function json(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function currentTone(ownerEmail: string) {
  const profile = await readVoiceProfile(ownerEmail);
  if (!profile) {
    throw new Error("Build a voice profile before tuning its tone.");
  }
  const preferences = await readTonePreferences(ownerEmail);
  if (preferences) {
    return { vector: preferences.vector, selections: preferences.selections, last_selection: preferences.last_selection, updated_at: preferences.updated_at };
  }
  return { vector: inferBaseTone(profile.profile), selections: 0, last_selection: null, updated_at: profile.generated_at };
}

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  try {
    return json(await currentTone(session.email));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not load tone preferences." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });

  let body: { email_key?: unknown; style?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, { status: 400 });
  }
  if (typeof body.email_key !== "string" || !/^[a-f0-9]{64}$/.test(body.email_key)) {
    return json({ error: "A valid generated-example key is required." }, { status: 400 });
  }
  if (!isResponseStyle(body.style)) {
    return json({ error: "style must be direct, warm, or polished." }, { status: 400 });
  }
  const emailKey = body.email_key;
  const style = body.style;

  try {
    await ensureAccountDataDirectory(session.email);
    const saved = await withFileLock(accountLockPath(session.email, "voice_preferences.lock"), async () => {
      const profile = await readVoiceProfile(session.email);
      if (!profile) {
        throw new Error("Build a voice profile before tuning its tone.");
      }
      const cache = await readVoiceExampleCache(session.email);
      const generated = cache[emailKey];
      if (!generated?.responses || generated.owner_email.toLowerCase() !== session.email.toLowerCase()) {
        throw new Error("Generate response examples before selecting a preferred style.");
      }
      if (!generated.responses.some((response) => response.id === style)) {
        throw new Error("That style was not present in the generated response set.");
      }
      return saveToneSelection({
        ownerEmail: session.email,
        emailKey,
        style,
        base: inferBaseTone(profile.profile),
      });
    });
    return json({
      vector: saved.vector,
      selections: saved.selections,
      last_selection: saved.last_selection,
      applied_style: saved.selected_styles?.[emailKey] ?? style,
      updated_at: saved.updated_at,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not save tone preference." }, { status: 400 });
  }
}
