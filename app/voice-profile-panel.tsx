"use client";

import Script from "next/script";
import { useCallback, useEffect, useState } from "react";
import { getGmailToken } from "@/lib/client-gmail-token";

type Usage = {
  total_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  total_cost: number;
};

type StoredProfile = {
  generated_at: string;
  sampled_emails: number;
  profile: Record<string, string | string[]>;
};

type ProfileState = {
  profile: StoredProfile | null;
  usage: Usage;
  configured: boolean;
};

const EMPTY_USAGE: Usage = {
  total_calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  total_cost: 0,
};

export function VoiceProfilePanel({ clientId }: { clientId: string }) {
  const [scriptReady, setScriptReady] = useState(false);
  const [state, setState] = useState<ProfileState>({ profile: null, usage: EMPTY_USAGE, configured: false });
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalEmail, setOriginalEmail] = useState("");
  const [context, setContext] = useState("");
  const [draft, setDraft] = useState("");
  const [drafting, setDrafting] = useState(false);

  const loadProfile = useCallback(async () => {
    const response = await fetch("/api/voice-profile", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Could not load the voice profile.");
    setState(payload as ProfileState);
  }, []);

  useEffect(() => {
    loadProfile().catch((reason) => setError(reason.message)).finally(() => setLoading(false));
  }, [loadProfile]);

  async function buildProfile(refresh: boolean) {
    if (building) return;
    setBuilding(true);
    setError(null);
    try {
      const accessToken = await getGmailToken(clientId, ["https://www.googleapis.com/auth/gmail.readonly"]);
      const response = await fetch("/api/voice-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken, refresh }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Profile generation failed.");
      setState((current) => ({ ...current, profile: payload.profile, usage: payload.usage }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Profile generation failed.");
    } finally {
      setBuilding(false);
    }
  }

  async function generateDraft() {
    if (!originalEmail.trim() || drafting) return;
    setDrafting(true);
    setDraft("");
    setError(null);
    try {
      const response = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ original_email: originalEmail, context }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Draft generation failed.");
      setDraft(payload.draft);
      setState((current) => ({ ...current, usage: payload.usage }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Draft generation failed.");
    } finally {
      setDrafting(false);
    }
  }

  return (
    <section className="voice-section" aria-labelledby="voice-title">
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setScriptReady(true)} />
      <div className="section-heading">
        <div>
          <h2 id="voice-title">Voice profile</h2>
          <p>Built once from at most 1,000 sent emails, then reused from local storage.</p>
        </div>
        {state.profile && (
          <button className="secondary-button" type="button" onClick={() => buildProfile(true)} disabled={!scriptReady || building || !state.configured}>
            {building ? "Refreshing…" : "Refresh profile"}
          </button>
        )}
      </div>

      {loading ? (
        <p className="status-message">Loading profile…</p>
      ) : state.profile ? (
        <>
          <div className="profile-meta">
            <span>{state.profile.sampled_emails} emails sampled</span>
            <span>Generated {new Date(state.profile.generated_at).toLocaleString()}</span>
          </div>
          <pre className="profile-json">{JSON.stringify(state.profile.profile, null, 2)}</pre>
        </>
      ) : (
        <div className="empty-profile">
          <p>No cached voice profile yet.</p>
          <button className="primary-button" type="button" onClick={() => buildProfile(false)} disabled={!scriptReady || building || !state.configured}>
            {building ? "Building one-time profile…" : "Build voice profile"}
          </button>
          {!state.configured && <p className="config-message">OpenRouter is not configured, so no model call can run yet.</p>}
        </div>
      )}

      <div className="usage-summary" aria-label="OpenRouter usage summary">
        <strong>OpenRouter usage</strong>
        <span>{state.usage.total_calls} calls</span>
        <span>{state.usage.total_tokens.toLocaleString()} tokens</span>
        <span>${state.usage.total_cost.toFixed(6)}</span>
      </div>

      {state.profile && (
        <div className="draft-tester">
          <h3>Draft with cached voice</h3>
          <textarea value={originalEmail} onChange={(event) => setOriginalEmail(event.target.value)} placeholder="Original email" aria-label="Original email" />
          <textarea value={context} onChange={(event) => setContext(event.target.value)} placeholder="Relevant thread context (optional)" aria-label="Relevant thread context" />
          <button className="primary-button" type="button" onClick={generateDraft} disabled={!originalEmail.trim() || drafting}>
            {drafting ? "Drafting…" : "Generate draft"}
          </button>
          {draft && <pre className="draft-output">{draft}</pre>}
        </div>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
    </section>
  );
}
