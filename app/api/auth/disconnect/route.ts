import { NextResponse } from "next/server";
import { sessionCookie } from "@/lib/session";
import { getSession } from "@/lib/session";
import { removeGoogleConnection } from "@/lib/google-connection";

export async function POST() {
  const session = await getSession();
  if (session) await removeGoogleConnection(session.email);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, "", { ...sessionCookie.options, maxAge: 0 });
  return response;
}
