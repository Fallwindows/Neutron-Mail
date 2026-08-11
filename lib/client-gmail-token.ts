"use client";

const STORAGE_KEY = "iris.gmail.oauth-token.v1";
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

type StoredToken = { accessToken: string; scopes: string[]; expiresAt: number };

function readToken(): StoredToken | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as StoredToken | null;
    if (!value?.accessToken || !Array.isArray(value.scopes) || value.expiresAt <= Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function rememberGmailToken(accessToken: string, scopes: string[]) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken, scopes, expiresAt: Date.now() + TOKEN_LIFETIME_MS } satisfies StoredToken));
}

export async function getGmailToken(clientId: string, scopes: string[]) {
  try {
    const connection = await fetch("/api/auth/google", { cache: "no-store" });
    if (connection.ok && ((await connection.json()) as { connected?: boolean }).connected) return "";
  } catch {
    // Fall through to the temporary browser-token compatibility path.
  }
  const stored = readToken();
  if (stored && scopes.every((scope) => stored.scopes.includes(scope))) return stored.accessToken;
  if (!window.google?.accounts.oauth2) throw new Error("Google access is still loading. Try again in a moment.");

  const requestedScopes = [...new Set([...(stored?.scopes ?? []), ...scopes])];
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: requestedScopes.join(" "),
      error_callback: () => reject(new Error("Gmail permission was cancelled or blocked. Allow the Google popup and try again.")),
      callback: (response) => {
        if (!response.access_token) {
          reject(new Error(response.error ?? "Gmail permission was not granted."));
          return;
        }
        rememberGmailToken(response.access_token, requestedScopes);
        resolve(response.access_token);
      },
    });
    client.requestAccessToken({ prompt: stored ? "" : "consent" });
  });
}
