import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getUsageSummary } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await getSession())) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const response = NextResponse.json(await getUsageSummary());
  response.headers.set("Cache-Control", "no-store");
  return response;
}
