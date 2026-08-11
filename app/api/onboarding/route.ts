import { NextResponse } from "next/server";
import { readGoalsProfile, readImportanceRules } from "@/lib/importance";
import { completeOnboarding, ONBOARDING_VERSION, readOnboarding } from "@/lib/onboarding";
import { getSession } from "@/lib/session";
import { readVoiceProfile } from "@/lib/voice-profile";

export const dynamic = "force-dynamic";

function json(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });

  const [onboarding, voice, goals, rules] = await Promise.all([
    readOnboarding(session.email),
    readVoiceProfile(session.email),
    readGoalsProfile(session.email),
    readImportanceRules(session.email),
  ]);

  return json({
    completed: onboarding?.version === ONBOARDING_VERSION,
    completed_at: onboarding?.completed_at ?? null,
    voice: voice ? { ready: true, sampled_emails: voice.sampled_emails, profile: voice.profile } : { ready: false },
    importance: goals ? { ready: true, sampled_emails: goals.sampled_emails, profile: goals.profile } : { ready: false },
    rules,
  });
}

export async function POST() {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });

  const [voice, goals] = await Promise.all([
    readVoiceProfile(session.email),
    readGoalsProfile(session.email),
  ]);
  if (!voice || !goals) {
    return json({ error: "Finish voice and importance setup before completing onboarding." }, { status: 400 });
  }

  const onboarding = await completeOnboarding(session.email);
  return json({ completed: true, completed_at: onboarding.completed_at });
}
