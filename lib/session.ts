import { cookies } from "next/headers";

const COOKIE_NAME = "iris_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 8;

type Session = { email: string; exp: number };

function encode(value: string) {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
  return value;
}

async function sign(payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(signature).toString("base64url");
}

export async function createSession(email: string) {
  const payload = encode(JSON.stringify({
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS,
  } satisfies Session));
  return `${payload}.${await sign(payload)}`;
}

export async function getSession(): Promise<Session | null> {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  if (!value) return null;

  try {
    const [payload, signature] = value.split(".");
    if (!payload || !signature || (await sign(payload)) !== signature) return null;
    const session = JSON.parse(decode(payload)) as Session;
    if (!session.email || session.exp <= Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export const sessionCookie = {
  name: COOKIE_NAME,
  options: {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  },
};
