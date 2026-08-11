"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useState } from "react";
import { getGmailToken } from "@/lib/client-gmail-token";

type SetupState = {
  completed: boolean;
  voice: { ready: boolean; sampled_emails?: number };
  importance: { ready: boolean; sampled_emails?: number };
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Something went wrong.");
  return body as T;
}

export function OnboardingFlow({ email, clientId }: { email: string; clientId: string }) {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState<"voice" | "importance" | "finish" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSetup = useCallback(async () => {
    const result = await api<SetupState>("/api/onboarding");
    setSetup(result);
  }, []);

  useEffect(() => {
    loadSetup().catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load setup."));
  }, [loadSetup]);

  function withGmailAccess(step: "voice" | "importance", work: (token: string) => Promise<void>) {
    setError(null);
    if (!clientId) {
      setError("Google sign-in is waiting for a client ID.");
      return;
    }
    setBusy(step);
    getGmailToken(clientId, ["https://www.googleapis.com/auth/gmail.readonly"])
      .then(work)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Setup could not be completed."))
      .finally(() => setBusy(null));
  }

  function buildVoice() {
    withGmailAccess("voice", async (token) => {
      await api("/api/voice-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token, refresh: false }),
      });
      await loadSetup();
    });
  }

  function buildImportance() {
    withGmailAccess("importance", async (token) => {
      await api("/api/importance/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token, refresh: false }),
      });
      await loadSetup();
    });
  }

  async function finishSetup() {
    setBusy("finish");
    setError(null);
    try {
      await api("/api/onboarding", { method: "POST" });
      window.location.assign("/dashboard");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not finish setup.");
      setBusy(null);
    }
  }

  const voiceReady = setup?.voice.ready ?? false;
  const importanceReady = setup?.importance.ready ?? false;
  const readyToFinish = voiceReady && importanceReady;
  const completedCount = Number(voiceReady) + Number(importanceReady);

  return (
    <main className="onboarding-shell">
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      <header className="onboarding-header">
        <Link className="brand" href="/dashboard" aria-label="Back to Iris inbox"><span className="brand-mark"><span /></span><span>Iris</span></Link>
        <div><span>{email}</span><Link href="/dashboard">Back to inbox</Link></div>
      </header>

      <section className="onboarding-card" aria-labelledby="setup-title">
        <div className="onboarding-intro">
          <p className="eyebrow">Personalization setup</p>
          <h1 id="setup-title">Teach Iris what sounds right and what matters.</h1>
          <p>Two one-time steps personalize drafts and ranking. You can leave at any time; your inbox remains the default workspace.</p>
          <div className="setup-progress" aria-label={`${completedCount} of 2 setup steps complete`}>
            <span><i style={{ width: `${completedCount * 50}%` }} /></span><b>{completedCount} of 2 complete</b>
          </div>
        </div>

        <ol className="setup-steps">
          <li className={voiceReady ? "complete" : "current"}>
            <span className="setup-step-number">{voiceReady ? "✓" : "1"}</span>
            <div>
              <p className="kicker">Voice</p>
              <h2>Learn how you write</h2>
              <p>Iris analyzes up to 1,000 sent messages once and keeps a compact voice profile for future drafts.</p>
              {voiceReady ? <span className="setup-complete-label">Voice profile ready{setup?.voice.sampled_emails ? ` · ${setup.voice.sampled_emails} emails learned` : ""}</span> : <button className="button primary" onClick={buildVoice} disabled={!setup || busy !== null}>{!setup ? "Loading…" : busy === "voice" ? "Learning your voice…" : "Set up voice"}</button>}
            </div>
          </li>
          <li className={importanceReady ? "complete" : voiceReady ? "current" : "locked"}>
            <span className="setup-step-number">{importanceReady ? "✓" : "2"}</span>
            <div>
              <p className="kicker">Importance</p>
              <h2>Learn what deserves attention</h2>
              <p>Iris reviews up to 50 inbox messages once to build a reusable goals profile for ranking.</p>
              {importanceReady ? <span className="setup-complete-label">Importance profile ready{setup?.importance.sampled_emails ? ` · ${setup.importance.sampled_emails} emails learned` : ""}</span> : <button className="button primary" onClick={buildImportance} disabled={!voiceReady || busy !== null}>{busy === "importance" ? "Learning your priorities…" : "Set up importance"}</button>}
              {!voiceReady && !importanceReady && <small>Complete voice setup first.</small>}
            </div>
          </li>
        </ol>

        {error && <p className="onboarding-error" role="alert">{error}</p>}

        <div className="onboarding-actions">
          <Link className="button secondary" href="/dashboard">Return to inbox</Link>
          <button className="button primary" onClick={finishSetup} disabled={!readyToFinish || busy !== null}>{setup?.completed ? "Done" : busy === "finish" ? "Finishing…" : "Finish setup"}</button>
        </div>
      </section>
    </main>
  );
}
