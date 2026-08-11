"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, MouseEvent } from "react";
import { getGmailToken } from "@/lib/client-gmail-token";

type RankedEmail = { id: string; thread_id: string; rfc_message_id: string; sender: string; subject: string; snippet: string; body: string; received_at: string; unread: boolean; score: number; importance_score?: number; needs_reply_score?: number; needs_reply?: boolean; important: boolean; reasons: string[] };
type DraftState = { primary?: string; alternatives?: string[]; loading?: boolean; alternativesLoading?: boolean; error?: string };
type Taste = { warmth: number; directness: number; formality: number; brevity: number; energy: number; word_count: number; greeting: string; signoff: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Something went wrong.");
  return payload as T;
}

function displayName(sender: string) { return sender.split("<")[0].replace(/[\"]/g, "").trim() || sender; }
function initials(sender: string) { const parts = displayName(sender).split(/\s+/).filter(Boolean); return (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? ""); }
function timeAgo(value: string) { const minutes = Math.max(1, Math.round((Date.now() - Date.parse(value)) / 60000)); if (minutes < 60) return `${minutes}m`; const hours = Math.round(minutes / 60); return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`; }

export function RankedInboxWorkflow({ clientId }: { clientId: string }) {
  const [emails, setEmails] = useState<RankedEmail[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ text: string; original: string; source: "generated" | "edited" } | null>(null);
  const [saving, setSaving] = useState(false);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const [needsRescan, setNeedsRescan] = useState(false);
  const [taste, setTaste] = useState<Taste | null>(null);
  const [quickReply, setQuickReply] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const hoverTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const requested = useRef(new Set<string>());

  useEffect(() => {
    api<{ preferences: Taste | null }>("/api/inbox/taste").then((result) => setTaste(result.preferences)).catch(() => undefined);
    api<{ emails: RankedEmail[]; needs_rescan?: boolean }>("/api/importance/inbox").then((result) => {
      setNeedsRescan(result.needs_rescan === true);
      if (!result.emails.length) return;
      setEmails(result.emails);
      setSelectedId(result.emails[0]?.id ?? null);
    }).catch(() => undefined);
    const timers = hoverTimers.current;
    return () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
  }, []);

  const generatePrimary = useCallback(async (email: RankedEmail) => {
    if (requested.current.has(email.id)) return;
    requested.current.add(email.id);
    setDrafts((current) => ({ ...current, [email.id]: { ...current[email.id], loading: true, error: undefined } }));
    try {
      const result = await api<{ draft: string }>("/api/inbox/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message_id: email.id, sender: email.sender, subject: email.subject, email: email.body, mode: "primary" }) });
      setDrafts((current) => ({ ...current, [email.id]: { ...current[email.id], primary: result.draft, loading: false } }));
    } catch (caught) {
      setDrafts((current) => ({ ...current, [email.id]: { ...current[email.id], loading: false, error: caught instanceof Error ? caught.message : "Could not draft a response." } }));
    }
  }, []);

  function preparePreview(email: RankedEmail, delay = 700) {
    setSelectedId(email.id); setEditor(null); setQuickReply(""); setRefineError(null); setSentNotice(null);
    const previous = hoverTimers.current.get(email.id); if (previous) clearTimeout(previous);
    if (drafts[email.id]?.primary || requested.current.has(email.id)) return;
    hoverTimers.current.set(email.id, setTimeout(() => { hoverTimers.current.delete(email.id); generatePrimary(email); }, delay));
  }

  function cancelPreview(emailId: string) { const timer = hoverTimers.current.get(emailId); if (timer) clearTimeout(timer); hoverTimers.current.delete(emailId); }
  function onRowLeave(event: MouseEvent<HTMLButtonElement>, emailId: string) { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancelPreview(emailId); }
  function onRowBlur(event: FocusEvent<HTMLButtonElement>, emailId: string) { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancelPreview(emailId); }

  function scanInbox() {
    if (scanning) return;
    setScanning(true); setError(null); setEditor(null); setSentNotice(null);
    getGmailToken(clientId, ["https://www.googleapis.com/auth/gmail.readonly"])
      .then((accessToken) => api<{ emails: RankedEmail[] }>("/api/importance/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: accessToken }) }))
      .then((result) => { setEmails(result.emails); setSelectedId(result.emails[0]?.id ?? null); setNeedsRescan(false); setDrafts({}); requested.current.clear(); })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Inbox scan failed."))
      .finally(() => setScanning(false));
  }

  async function generateAlternatives(email: RankedEmail) {
    const state = drafts[email.id];
    if (!state?.primary || state.alternatives || state.alternativesLoading) return;
    setDrafts((current) => ({ ...current, [email.id]: { ...current[email.id], alternativesLoading: true, error: undefined } }));
    try {
      const result = await api<{ responses: string[] }>("/api/inbox/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message_id: email.id, sender: email.sender, subject: email.subject, email: email.body, mode: "alternatives" }) });
      setDrafts((current) => ({ ...current, [email.id]: { ...current[email.id], alternatives: result.responses, alternativesLoading: false } }));
    } catch (caught) {
      setDrafts((current) => ({ ...current, [email.id]: { ...current[email.id], alternativesLoading: false, error: caught instanceof Error ? caught.message : "Could not generate alternatives." } }));
    }
  }

  function editResponse(text: string) { setSentNotice(null); setEditor({ text, original: text, source: "generated" }); }

  async function refineFromQuickReply(email: RankedEmail) {
    const instruction = quickReply.trim();
    if (!instruction || refining) return;
    setRefining(true); setRefineError(null); setSentNotice(null);
    try {
      const result = await api<{ draft: string; learning_count: number }>("/api/inbox/refine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message_id: email.id, sender: email.sender, subject: email.subject, email: email.body, instruction }) });
      setEditor({ text: result.draft, original: result.draft, source: "generated" });
      setQuickReply("");
    } catch (caught) { setRefineError(caught instanceof Error ? caught.message : "Could not rewrite your quick reply."); }
    finally { setRefining(false); }
  }

  async function commitResponse(email: RankedEmail) {
    if (!editor?.text.trim() || saving) return;
    const replyText = editor.text.trim();
    const source = replyText === editor.original.trim() ? "generated" : "edited";
    setSaving(true); setError(null); setSentNotice(null);
    try {
      const accessToken = await getGmailToken(clientId, [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ]);
      await api<{ sent: true; message_id: string | null }>("/api/inbox/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken, message_id: email.id, text: replyText }),
      });

      let notice = `Reply sent to ${displayName(email.sender)}.`;
      try {
        const learned = await api<{ preferences: Taste }>("/api/inbox/taste", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message_id: email.id, text: replyText, source }) });
        setTaste(learned.preferences);
      } catch {
        notice += " It was sent, but Iris could not update your response taste.";
      }

      const currentIndex = emails.findIndex((item) => item.id === email.id);
      const remaining = emails.filter((item) => item.id !== email.id);
      setEmails(remaining);
      setSelectedId(remaining[Math.min(currentIndex, remaining.length - 1)]?.id ?? null);
      setEditor(null); setQuickReply(""); setRefineError(null); setSentNotice(notice);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not send this reply."); }
    finally { setSaving(false); }
  }

  const selected = emails.find((email) => email.id === selectedId) ?? null;
  const selectedDraft = selected ? drafts[selected.id] : undefined;
  const choices = selectedDraft?.primary ? [selectedDraft.primary, ...(selectedDraft.alternatives ?? [])] : [];

  return (
    <section className="product-section inbox-workflow-section" id="inbox" aria-labelledby="inbox-workflow-title">
      <div className="section-intro"><div><p className="eyebrow">Priority inbox</p><h2 id="inbox-workflow-title">The messages that need you, first.</h2><p>Scan your inbox now. Iris ranks every message with the signals available today, then becomes more personal after setup.</p></div><span className={`section-state ${emails.length ? "ready" : ""}`}>{emails.length ? `${emails.length} ranked` : "Ready to scan"}</span></div>
      <article className="panel workflow-panel">
        <div className="workflow-toolbar"><div><p className="kicker">Live inbox</p><h3>Ranked by your importance engine</h3><p>Your latest filtered scan is saved locally. Refresh only when you want newer mail; drafts are generated on demand.</p></div><button className="button secondary" onClick={scanInbox} disabled={scanning}>{scanning ? "Refreshing…" : emails.length ? "Refresh inbox" : "Scan inbox"}</button></div>
        {error && <p className="inline-error" role="alert">{error}</p>}
        {needsRescan && <p className="status-message" role="status">Refresh once to add independent importance and needs-reply scoring to this saved inbox.</p>}
        {sentNotice && <p className="status-message" role="status">{sentNotice}</p>}
        {!emails.length ? <div className="inbox-empty workflow-empty"><span aria-hidden="true">↓</span><div><b>Your ranked inbox will appear here</b><p>Run one filtered scan to create your saved account-local inbox cache.</p></div></div> :
          <div className="workflow-grid">
            <div className="workflow-list" aria-label="Ranked inbox messages">
              {emails.map((email, index) => <button key={email.id} className={`workflow-email ${selectedId === email.id ? "active" : ""}`} onMouseEnter={() => preparePreview(email)} onMouseLeave={(event) => onRowLeave(event, email.id)} onFocus={() => preparePreview(email, 500)} onBlur={(event) => onRowBlur(event, email.id)} onClick={() => preparePreview(email, 0)} aria-pressed={selectedId === email.id}>
                <span className="rank-number">{String(index + 1).padStart(2, "0")}</span><span className="avatar small">{initials(email.sender)}</span><span className="workflow-email-copy"><span><b>{displayName(email.sender)}</b><time>{timeAgo(email.received_at)}</time></span><strong>{email.subject || "(No subject)"}</strong><small>{email.snippet}</small><span className="reason-list">{email.needs_reply && <i>Needs reply · {email.needs_reply_score}</i>}{email.reasons.map((reason) => <i key={reason}>{reason}</i>)}</span></span><span className={`score-ring ${email.important ? "high" : ""}`} style={{ "--score": `${email.score * 3.6}deg` } as CSSProperties}><span>{email.score}</span><small>importance</small></span>
              </button>)}
            </div>
            <aside className="draft-preview" aria-live="polite">
              {!selected ? <div className="draft-placeholder"><b>Select a message</b><p>Your draft will appear here.</p></div> : <>
                <div className="draft-preview-heading"><span><small>Replying to</small><b>{displayName(selected.sender)}</b></span><span className="guard-badge">1-call guard</span></div>
                <h4>{selected.subject || "(No subject)"}</h4>
                {selectedDraft?.loading && <div className="draft-loading"><span className="spinner" />Writing one cached response…</div>}
                {selectedDraft?.error && <p className="inline-error" role="alert">{selectedDraft.error}</p>}
                {!selectedDraft?.loading && !selectedDraft?.primary && !selectedDraft?.error && <div className="draft-placeholder"><b>Pause here to draft</b><p>Iris waits for a stable hover or focus so moving through the list cannot create calls.</p></div>}
                {choices.length > 0 && <div className="draft-choices">{choices.map((choice, index) => <button key={`${selected.id}-${index}`} onClick={() => editResponse(choice)}><span>{index === 0 ? "Recommended" : `Alternative ${index}`}</span><p>{choice}</p><b>Edit this response →</b></button>)}</div>}
                {selectedDraft?.primary && !selectedDraft.alternatives && <button className="button secondary wide" onClick={() => generateAlternatives(selected)} disabled={selectedDraft.alternativesLoading}>{selectedDraft.alternativesLoading ? "Generating exactly 2…" : "Generate 2 other responses"}</button>}
                {selectedDraft?.primary && <div className="quick-reply-box"><label htmlFor="inbox-quick-reply">Not what you meant?</label><p>Type your intent in one quick sentence. Iris will turn it into a polished reply in your voice and remember the guidance for future drafts.</p><textarea id="inbox-quick-reply" value={quickReply} onChange={(event) => { setQuickReply(event.target.value.slice(0, 600)); setRefineError(null); }} placeholder="e.g. Thank them, but say I can't meet this week and ask about next Tuesday." rows={3} maxLength={600} disabled={refining} /><div><small>{quickReply.length}/600</small><button className="button primary" onClick={() => refineFromQuickReply(selected)} disabled={refining || !quickReply.trim()}>{refining ? "Rewriting…" : "Rewrite in my voice"}</button></div>{refining && <div className="draft-loading"><span className="spinner" />Formatting your reply and updating your learning profile…</div>}{refineError && <p className="inline-error" role="alert">{refineError}</p>}</div>}
                {editor && <div className="draft-editor"><label htmlFor="inbox-draft-editor">Edit before sending</label><textarea id="inbox-draft-editor" value={editor.text} onChange={(event) => { setSentNotice(null); setEditor({ ...editor, text: event.target.value }); }} rows={10} disabled={saving} /><div><small>{editor.text.trim().split(/\s+/).filter(Boolean).length} words · Gmail asks for send permission before sending</small><button className="button primary" onClick={() => commitResponse(selected)} disabled={saving || !editor.text.trim()}>{saving ? "Sending…" : "Send this response"}</button></div></div>}
              </>}
            </aside>
          </div>}
        {taste && <div className="taste-strip"><span><b>Response taste</b><small>Updated only after Gmail confirms your reply was sent</small></span>{(["warmth", "directness", "formality", "brevity", "energy"] as const).map((axis) => <span key={axis}><small>{axis}</small><b>{taste[axis]}</b></span>)}</div>}
      </article>
    </section>
  );
}
