"use client";

import Script from "next/script";
import { useEffect, useState } from "react";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

declare global {
  interface Window {
    google?: {
      accounts: {
        id: { disableAutoSelect(): void };
        oauth2: {
          initTokenClient(options: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string }) => void;
            error_callback?: (error: { type?: string }) => void;
          }): {
            requestAccessToken(options?: { prompt?: string }): void;
          };
          initCodeClient(options: {
            client_id: string;
            scope: string;
            ux_mode: "popup";
            access_type?: "offline" | "online";
            prompt?: string;
            include_granted_scopes?: boolean;
            callback: (response: { code?: string; error?: string }) => void;
            error_callback?: (error: { type?: string }) => void;
          }): {
            requestCode(): void;
          };
        };
      };
    };
  }
}

export function AuthPanel({
  email,
  clientId,
  compact = false,
  redirectTo = "/dashboard",
  disconnectTo = "/",
}: {
  email: string | null;
  clientId: string;
  compact?: boolean;
  redirectTo?: string;
  disconnectTo?: string;
}) {
  const [scriptReady, setScriptReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (!email) return;
    fetch("/api/auth/google", { cache: "no-store" })
      .then(async (response) => response.ok && Boolean(((await response.json()) as { connected?: boolean }).connected))
      .then(setGmailConnected)
      .catch(() => setGmailConnected(false));
  }, [email]);

  function signIn() {
    if (!scriptReady || !window.google?.accounts.oauth2) {
      setError("Google sign-in is still loading. Please try again.");
      return;
    }

    setBusy(true);
    setError(null);
    const client = window.google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: ["openid", "email", "profile", ...GMAIL_SCOPES].join(" "),
      ux_mode: "popup",
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: true,
      error_callback: () => {
        setError("Google sign-in was cancelled or blocked. Please allow popups and try again.");
        setBusy(false);
      },
      callback: (response) => {
        if (!response.code) {
          setError(response.error ?? "Google did not return an authorization code.");
          setBusy(false);
          return;
        }

        fetch("/api/auth/google", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XmlHttpRequest" },
          body: JSON.stringify({ code: response.code }),
        })
          .then(async (result) => {
            if (!result.ok) {
              const payload = await result.json().catch(() => ({})) as { error?: string };
              throw new Error(payload.error ?? "Sign-in could not be verified.");
            }
            window.location.assign(redirectTo);
          })
          .catch((caught) => {
            setError(caught instanceof Error ? caught.message : "Sign-in could not be verified. Please try again.");
            setBusy(false);
          });
      },
    });
    client.requestCode();
  }

  async function disconnect() {
    setBusy(true);
    setError(null);

    try {
      const result = await fetch("/api/auth/disconnect", { method: "POST" });
      if (!result.ok) throw new Error("Disconnect failed.");
      window.google?.accounts.id.disableAutoSelect();
      window.location.assign(disconnectTo);
    } catch {
      setError("Could not disconnect. Please try again.");
      setBusy(false);
    }
  }

  if (email) {
    return (
      <div className={`connected-state ${compact ? "compact" : ""}`} aria-live="polite">
        <Script
          src="https://accounts.google.com/gsi/client"
          strategy="afterInteractive"
          onReady={() => setScriptReady(true)}
        />
        <div className="checkmark" aria-hidden="true">✓</div>
        <p className="connected-label">
          {gmailConnected === false ? "Signed in as" : "Connected as"} <strong>{email}</strong>
        </p>
        {gmailConnected === false && (
          <button className="button primary google-button" type="button" onClick={signIn} disabled={busy || !scriptReady}>
            {busy ? "Connecting…" : "Connect Gmail once"}
          </button>
        )}
        <button className="disconnect-button" type="button" onClick={disconnect} disabled={busy}>
          {busy ? "Disconnecting…" : "Disconnect"}
        </button>
        {error && <p className="error-message" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className="sign-in-state">
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
      />
      {clientId ? (
        <>
          <button className="button primary google-button" type="button" onClick={signIn} disabled={busy || !scriptReady}>
            {busy ? "Connecting…" : scriptReady ? "Continue with Google" : "Loading Google…"}
          </button>
          {busy && <p className="status-message" aria-live="polite">Verifying your account…</p>}
        </>
      ) : (
        <p className="config-message" role="status">Google sign-in is waiting for a client ID.</p>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
    </div>
  );
}
