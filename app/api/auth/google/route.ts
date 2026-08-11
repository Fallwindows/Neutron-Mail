import { OAuth2Client } from "google-auth-library";
import { NextResponse } from "next/server";
import { createSession, getSession, sessionCookie } from "@/lib/session";
import { createGoogleOAuthClient, hasGoogleConnection, saveGoogleConnection } from "@/lib/google-connection";

function googleOAuthErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";

  if (message.includes("invalid_grant")) {
    return "Google authorization expired or was already used. Close the popup and try connecting again.";
  }
  if (message.includes("redirect_uri_mismatch")) {
    return "This site URL is not authorized in Google Cloud. Add the exact current URL as an authorized JavaScript origin.";
  }
  if (message.includes("invalid_client")) {
    return "Google OAuth is misconfigured. Check that the client ID and server-side client secret belong to the same Web application.";
  }

  return "Google could not verify this sign-in. Please close the popup and try again.";
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ connected: false }, { status: 401 });
  return NextResponse.json({ connected: await hasGoogleConnection(session.email) });
}

export async function POST(request: Request) {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: "Google sign-in is not configured." }, { status: 503 });

  try {
    const existingSession = await getSession();
    const body = (await request.json()) as { credential?: unknown; access_token?: unknown; code?: unknown };
    const oauth = new OAuth2Client(clientId);
    let payload: { email?: string; email_verified?: boolean } | undefined;

    let refreshToken: string | undefined;
    let scopes: string[] = [];
    if (typeof body.code === "string" && body.code.length <= 4096) {
      const origin = request.headers.get("origin");
      const forwardedHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
      const forwardedProto = (request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "")).split(",")[0].trim();
      let validOrigin = false;
      try {
        const parsedOrigin = new URL(origin ?? "");
        validOrigin = parsedOrigin.host === forwardedHost && parsedOrigin.protocol === `${forwardedProto}:`;
      } catch {
        validOrigin = false;
      }
      if (request.headers.get("x-requested-with") !== "XmlHttpRequest" || !origin || !validOrigin) {
        return NextResponse.json({ error: "Invalid OAuth request origin." }, { status: 403 });
      }
      const codeClient = createGoogleOAuthClient(origin);
      const exchanged = await codeClient.getToken(body.code);
      refreshToken = exchanged.tokens.refresh_token ?? undefined;
      scopes = exchanged.tokens.scope?.split(" ").filter(Boolean) ?? [];
      if (!refreshToken || !exchanged.tokens.access_token) {
        return NextResponse.json({ error: "Google did not provide offline access. Reconnect and approve consent." }, { status: 401 });
      }
      const token = await oauth.getTokenInfo(exchanged.tokens.access_token);
      if (token.aud !== clientId || token.expiry_date <= Date.now()) return NextResponse.json({ error: "Invalid Google authorization." }, { status: 401 });
      const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${exchanged.tokens.access_token}` }, cache: "no-store" });
      if (!userInfoResponse.ok) return NextResponse.json({ error: "Google profile could not be verified." }, { status: 401 });
      payload = (await userInfoResponse.json()) as { email?: string; email_verified?: boolean };
    } else if (typeof body.access_token === "string") {
      const token = await oauth.getTokenInfo(body.access_token);
      if (token.aud !== clientId || token.expiry_date <= Date.now()) {
        return NextResponse.json({ error: "Google access token is not valid for this app." }, { status: 401 });
      }

      const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${body.access_token}` },
        cache: "no-store",
      });
      if (!userInfoResponse.ok) {
        return NextResponse.json({ error: "Google profile could not be verified." }, { status: 401 });
      }
      payload = (await userInfoResponse.json()) as { email?: string; email_verified?: boolean };
    } else if (typeof body.credential === "string") {
      const ticket = await oauth.verifyIdToken({ idToken: body.credential, audience: clientId });
      payload = ticket.getPayload();
    } else {
      return NextResponse.json({ error: "Missing Google credential." }, { status: 400 });
    }

    if (!payload?.email || !payload.email_verified) {
      return NextResponse.json({ error: "A verified Google email is required." }, { status: 401 });
    }

    if (existingSession && existingSession.email.toLowerCase() !== payload.email.toLowerCase()) {
      return NextResponse.json({ error: `Connect the Google account signed in as ${existingSession.email}.` }, { status: 409 });
    }

    if (refreshToken) await saveGoogleConnection(payload.email, refreshToken, scopes);

    const response = NextResponse.json({ ok: true, email: payload.email });
    response.cookies.set(sessionCookie.name, await createSession(payload.email), sessionCookie.options);
    return response;
  } catch (error) {
    return NextResponse.json({ error: googleOAuthErrorMessage(error) }, { status: 401 });
  }
}
