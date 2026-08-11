import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { fetchUnansweredEmails } from "@/lib/voice-inbox";
import { resolveGoogleAccessToken } from "@/lib/google-connection";

export const dynamic = "force-dynamic";

function json(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });

  let body: { access_token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, { status: 400 });
  }
  if (body.access_token !== undefined && (typeof body.access_token !== "string" || body.access_token.length > 4096)) {
    return json({ error: "A valid Gmail access token is required." }, { status: 400 });
  }

  try {
    const accessToken = await resolveGoogleAccessToken(session.email, body.access_token);
    const emails = await fetchUnansweredEmails(accessToken, session.email);
    return json({ emails });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not load unanswered emails." }, { status: 400 });
  }
}
