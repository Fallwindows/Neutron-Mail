"use client";

import Script from "next/script";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGmailToken } from "@/lib/client-gmail-token";
import { AuthPanel } from "./auth-panel";
import { RankedInboxWorkflow } from "./ranked-inbox-workflow";

type ToneVector = { warmth: number; directness: number; formality: number; brevity: number; energy: number };
type Style = "direct" | "warm" | "polished";
type VoiceEmail = { id: string; thread_id: string; from: string; subject: string; received_at: string; preview: string; body: string };
type VoiceReply = { id: Style; label: string; description: string; email: string };
type Profile = { generated_at: string; sampled_emails: number; profile: Record<string, string | string[]> };
type Goal = { goal: string; signals: string[]; weight: number };
type GoalsProfile = { generated_at: string; sampled_emails: number; profile: { summary: string; goals: Goal[]; priority_people: string[]; priority_organizations: string[]; priority_topics: string[] } };
type Category = "customers" | "investors" | "team" | "deadlines" | "finance" | "legal" | "security" | "hiring";
type Rules = { categories: Record<Category, boolean>; vip_senders: string[]; priority_keywords: string[]; ignore_keywords: string[] };
type ImportanceInstruction = { instruction: string; created_at: string; ignore_keywords: string[]; priority_keywords: string[]; vip_senders: string[] };
type ImportanceInstructions = { history: ImportanceInstruction[]; ignore_keywords: string[]; priority_keywords: string[]; vip_senders: string[] };

const EMPTY_TONE: ToneVector = { warmth: 50, directness: 50, formality: 50, brevity: 50, energy: 50 };
const CATEGORIES: Array<{ id: Category; label: string; detail: string }> = [
  { id: "customers", label: "Customers", detail: "Client requests and support" },
  { id: "investors", label: "Investors", detail: "Funding and introductions" },
  { id: "team", label: "Team", detail: "Projects and blockers" },
  { id: "deadlines", label: "Deadlines", detail: "Due dates and action items" },
  { id: "finance", label: "Finance", detail: "Invoices and payments" },
  { id: "legal", label: "Legal", detail: "Contracts and compliance" },
  { id: "security", label: "Security", detail: "Account and access alerts" },
  { id: "hiring", label: "Hiring", detail: "Candidates and interviews" },
];

function errorText(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Something went wrong.");
  return body as T;
}

function displayName(sender: string) { return sender.split("<")[0].replace(/[\"]/g, "").trim() || sender; }
function initials(sender: string) { const parts = displayName(sender).split(/\s+/).filter(Boolean); return (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? ""); }
function timeAgo(value: string) { const minutes = Math.max(1, Math.round((Date.now() - Date.parse(value)) / 60000)); if (minutes < 60) return `${minutes}m`; const hours = Math.round(minutes / 60); return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`; }

function RadarChart({ values }: { values: ToneVector }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const axes = useMemo(() => Object.keys(EMPTY_TONE) as Array<keyof ToneVector>, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = 300; const ratio = window.devicePixelRatio || 1;
    canvas.width = size * ratio; canvas.height = size * ratio;
    const context = canvas.getContext("2d"); if (!context) return;
    context.scale(ratio, ratio); context.clearRect(0, 0, size, size);
    const center = size / 2; const radius = 104;
    const point = (index: number, percent: number) => { const angle = -Math.PI / 2 + index * (Math.PI * 2 / axes.length); return [center + Math.cos(angle) * radius * percent, center + Math.sin(angle) * radius * percent] as const; };
    context.lineJoin = "round";
    for (let ring = 1; ring <= 4; ring += 1) { context.beginPath(); axes.forEach((_, index) => { const [x, y] = point(index, ring / 4); if (index === 0) context.moveTo(x, y); else context.lineTo(x, y); }); context.closePath(); context.strokeStyle = ring === 4 ? "#d9dce7" : "#e9eaf0"; context.lineWidth = 1; context.stroke(); }
    axes.forEach((_, index) => { const [x, y] = point(index, 1); context.beginPath(); context.moveTo(center, center); context.lineTo(x, y); context.strokeStyle = "#e5e7ed"; context.stroke(); });
    const gradient = context.createRadialGradient(center, center, 5, center, center, radius); gradient.addColorStop(0, "rgba(100,74,230,.17)"); gradient.addColorStop(1, "rgba(100,74,230,.32)");
    context.beginPath(); axes.forEach((axis, index) => { const [x, y] = point(index, values[axis] / 100); if (index === 0) context.moveTo(x, y); else context.lineTo(x, y); }); context.closePath(); context.fillStyle = gradient; context.fill(); context.strokeStyle = "#6548df"; context.lineWidth = 2.5; context.stroke();
    axes.forEach((axis, index) => { const [x, y] = point(index, values[axis] / 100); context.beginPath(); context.arc(x, y, 4, 0, Math.PI * 2); context.fillStyle = "#fff"; context.fill(); context.strokeStyle = "#6548df"; context.lineWidth = 2; context.stroke(); });
  }, [axes, values]);
  return <div className="radar-wrap"><canvas ref={canvasRef} className="radar-canvas" width="300" height="300" role="img" aria-label={`Tone profile: ${axes.map((axis) => `${axis} ${values[axis]}`).join(", ")}`} />{axes.map((axis, index) => <span className={`radar-label radar-label-${index}`} key={axis}>{axis}<b>{values[axis]}</b></span>)}</div>;
}

function BusyBlock({ label }: { label: string }) { return <div className="busy-block" role="status"><span className="spinner" />{label}</div>; }

type DashboardView = "inbox" | "voice" | "importance";

export function InboxDashboard({ email, clientId, view = "inbox" }: { email: string; clientId: string; view?: DashboardView }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tone, setTone] = useState<ToneVector>(EMPTY_TONE);
  const [voiceEmails, setVoiceEmails] = useState<VoiceEmail[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<VoiceEmail | null>(null);
  const [replies, setReplies] = useState<VoiceReply[]>([]);
  const [selectedReply, setSelectedReply] = useState<Style | null>(null);
  const [emailKey, setEmailKey] = useState("");
  const [trainedEmailIds, setTrainedEmailIds] = useState<string[]>([]);
  const [voiceBusy, setVoiceBusy] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [importance, setImportance] = useState<{ profile: GoalsProfile | null; rules: Rules; instructions: ImportanceInstructions } | null>(null);
  const [importanceBusy, setImportanceBusy] = useState<string | null>(null);
  const [importanceError, setImportanceError] = useState<string | null>(null);
  const [importanceInstruction, setImportanceInstruction] = useState("");
  const [importanceInstructionError, setImportanceInstructionError] = useState<string | null>(null);
  const [importanceSaved, setImportanceSaved] = useState<string | null>(null);
  const [rulesDirty, setRulesDirty] = useState(false);

  const loadInitial = useCallback(async () => {
    const [voice, preferences, priority] = await Promise.allSettled([
      api<{ profile: Profile | null }>("/api/voice-profile"),
      api<{ vector: ToneVector }>("/api/voice-lab/preferences"),
      api<{ profile: GoalsProfile | null; rules: Rules; instructions: ImportanceInstructions }>("/api/importance"),
    ]);
    if (voice.status === "fulfilled") setProfile(voice.value.profile);
    if (preferences.status === "fulfilled") setTone(preferences.value.vector);
    if (priority.status === "fulfilled") setImportance({ profile: priority.value.profile, rules: priority.value.rules, instructions: priority.value.instructions });
    if (voice.status === "rejected" && priority.status === "rejected") throw voice.reason;
  }, []);
  useEffect(() => { loadInitial().catch((error) => setVoiceError(errorText(error, "Could not load your workspace."))); }, [loadInitial]);
  function withGmailToken(work: (token: string) => Promise<void>, area: "voice" | "importance") {
    const setError = area === "voice" ? setVoiceError : setImportanceError;
    const setBusy = area === "voice" ? setVoiceBusy : setImportanceBusy;
    setError(null);
    getGmailToken(clientId, ["https://www.googleapis.com/auth/gmail.readonly"])
      .then(work)
      .catch((error) => setError(errorText(error, "Gmail request failed.")))
      .finally(() => setBusy(null));
  }

  function loadVoiceInbox() {
    setVoiceBusy("Finding emails waiting on you");
    withGmailToken(async (token) => { const result = await api<{ emails: VoiceEmail[] }>("/api/voice-lab/inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: token }) }); setVoiceEmails(result.emails); setSelectedEmail(result.emails[0] ?? null); setReplies([]); setSelectedReply(null); setEmailKey(""); setTrainedEmailIds([]); }, "voice");
  }

  function buildVoiceProfile() {
    setVoiceBusy("Learning your voice from sent email");
    withGmailToken(async (token) => {
      const result = await api<{ profile: Profile }>("/api/voice-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: token, refresh: false }) });
      setProfile(result.profile);
      const preferences = await api<{ vector: ToneVector }>("/api/voice-lab/preferences");
      setTone(preferences.vector);
    }, "voice");
  }

  async function generateExamplesFor(email: VoiceEmail) {
    setVoiceBusy("Writing three versions in your voice"); setVoiceError(null); setReplies([]); setSelectedReply(null); setEmailKey("");
    try { const result = await api<{ email_key: string; responses: VoiceReply[]; tone_vector: ToneVector }>("/api/voice-lab/examples", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message_id: email.id, from: email.from, subject: email.subject, email: email.body }) }); setReplies(result.responses); setTone(result.tone_vector); setEmailKey(result.email_key); }
    catch (error) { setVoiceError(errorText(error, "Could not create examples.")); } finally { setVoiceBusy(null); }
  }

  async function generateExamples() { if (selectedEmail) await generateExamplesFor(selectedEmail); }

  async function chooseReply(style: Style) {
    if (!emailKey) return;
    setVoiceBusy("Updating your tone profile"); setVoiceError(null);
    try {
      const result = await api<{ vector: ToneVector; applied_style: Style }>("/api/voice-lab/preferences", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email_key: emailKey, style }) });
      setTone(result.vector);
      if (selectedEmail && voiceEmails.length > 1) {
        const completedIds = new Set([...trainedEmailIds, selectedEmail.id]);
        setTrainedEmailIds([...completedIds]);
        const currentIndex = voiceEmails.findIndex((item) => item.id === selectedEmail.id);
        const emailsAfterCurrent = currentIndex >= 0
          ? [...voiceEmails.slice(currentIndex + 1), ...voiceEmails.slice(0, currentIndex)]
          : voiceEmails;
        const nextEmail = emailsAfterCurrent.find((item) => !completedIds.has(item.id))
          ?? emailsAfterCurrent.find((item) => item.id !== selectedEmail.id);
        if (nextEmail) {
          setSelectedEmail(nextEmail);
          await generateExamplesFor(nextEmail);
        } else setSelectedReply(result.applied_style);
      } else {
        if (selectedEmail) setTrainedEmailIds((current) => current.includes(selectedEmail.id) ? current : [...current, selectedEmail.id]);
        setSelectedReply(result.applied_style);
      }
    }
    catch (error) { setVoiceError(errorText(error, "Could not save this preference.")); } finally { setVoiceBusy(null); }
  }

  function updateRule<K extends keyof Rules>(key: K, value: Rules[K]) { setImportance((current) => current ? { ...current, rules: { ...current.rules, [key]: value } } : current); setRulesDirty(true); }
  async function saveRules() { if (!importance) return; setImportanceBusy("Saving preferences"); setImportanceError(null); try { const result = await api<{ rules: Rules }>("/api/importance/rules", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(importance.rules) }); setImportance((current) => current ? { ...current, rules: result.rules } : current); setRulesDirty(false); } catch (error) { setImportanceError(errorText(error, "Could not save preferences.")); } finally { setImportanceBusy(null); } }
  async function applyImportanceInstruction() {
    const instruction = importanceInstruction.trim(); if (!instruction || !importance) return;
    setImportanceBusy("Updating your importance rules"); setImportanceInstructionError(null); setImportanceSaved(null);
    try {
      const result = await api<{ instructions: ImportanceInstructions; visible_count: number | null }>("/api/importance/instructions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction }) });
      setImportance((current) => current ? { ...current, instructions: result.instructions } : current);
      setImportanceInstruction("");
      setImportanceSaved(result.visible_count === null ? "Preference saved. It will apply to your next inbox scan." : `Preference saved. Your cached inbox now shows ${result.visible_count} messages.`);
    } catch (error) { setImportanceInstructionError(errorText(error, "Could not apply that instruction.")); } finally { setImportanceBusy(null); }
  }
  function buildGoals(refresh: boolean) { setImportanceBusy(refresh ? "Refreshing your goals profile" : "Learning what matters to you"); withGmailToken(async (token) => { const result = await api<{ profile: GoalsProfile }>("/api/importance/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: token, refresh }) }); setImportance((current) => current ? { ...current, profile: result.profile } : current); }, "importance"); }

  const profileTraits = profile ? [String(profile.profile.tone ?? "Direct and professional"), ...(Array.isArray(profile.profile.signoffs) ? profile.profile.signoffs.slice(0, 2) : [])] : [];
  return (
    <main className="dashboard-shell">
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" />
      <header className="topbar">
        <Link className="brand" href="/dashboard" aria-label="Iris inbox"><span className="brand-mark"><span /></span><span>Iris</span></Link>
        <nav className="topnav" aria-label="Main navigation"><Link className={view === "inbox" ? "active" : ""} href="/dashboard">Inbox</Link><Link className={view === "voice" ? "active" : ""} href="/dashboard/voice">Voice</Link><Link className={view === "importance" ? "active" : ""} href="/dashboard/importance">Importance</Link></nav>
        <div className="account-cluster"><span className="live-dot" /><span className="account-email">{email}</span><AuthPanel email={email} clientId={clientId} compact /></div>
      </header>

      {view === "inbox" && <section className="hero"><div><p className="eyebrow">Your inbox</p><h1>Start with what matters.</h1><p>Your ranked inbox is the center of Iris. Voice and importance setup personalize it when you are ready.</p></div><div className="hero-status"><span className="status-orb">I</span><div><b>Inbox ready</b><span>{profile ? "Voice profile active" : "Personalization available"} · Gmail connected</span></div></div></section>}
      {view === "voice" && <section className="hero"><div><p className="eyebrow">Voice studio</p><h1>Make every reply sound like you.</h1><p>Build and refine the writing profile Iris uses when preparing inbox drafts.</p></div><div className="hero-status"><span className="status-orb">V</span><div><b>{profile ? "Voice profile active" : "Voice setup available"}</b><span>Private to {email}</span></div></div></section>}
      {view === "importance" && <section className="hero"><div><p className="eyebrow">Importance engine</p><h1>Define what deserves attention.</h1><p>Manage the goals, people, and rules Iris uses to rank your inbox.</p></div><div className="hero-status"><span className="status-orb">I</span><div><b>{importance?.profile ? "Goals profile active" : "Importance setup available"}</b><span>Ranking preferences saved locally</span></div></div></section>}

      {view === "inbox" && <><RankedInboxWorkflow clientId={clientId} />
      <aside className="onboarding-prompt" aria-labelledby="onboarding-prompt-title">
        <div><p className="eyebrow">Personalize Iris</p><h2 id="onboarding-prompt-title">Set up voice and importance in two guided steps.</h2><p>Your inbox stays your home. This optional setup teaches Iris how you write and what deserves attention.</p></div>
        <Link className="button primary" href="/dashboard/onboarding">{profile && importance?.profile ? "Review setup" : "Start setup"}</Link>
      </aside></>}

      {view === "voice" && <section className="product-section" id="voice" aria-labelledby="voice-title">
        <div className="section-intro"><div><span className="step-number">01</span><p className="eyebrow">Voice studio</p><h2 id="voice-title">Make every response sound like you.</h2><p>Choose the reply that feels most natural. Iris updates your tone with every decision.</p></div><span className={`section-state ${profile ? "ready" : ""}`}>{profile ? "Profile active" : "Setup needed"}</span></div>
        <div className="voice-grid">
          <article className="panel tone-panel"><div className="panel-heading"><div><p className="kicker">Your tone</p><h3>Voice fingerprint</h3></div><span className="sample-count">{profile ? `${profile.sampled_emails} emails learned` : "Not built yet"}</span></div>{profile ? <><RadarChart values={tone} /><div className="trait-list">{profileTraits.map((trait, index) => <span key={`${trait}-${index}`}>{trait}</span>)}</div><p className="microcopy">Your original profile stays intact. Choices fine-tune a lightweight preference layer.</p></> : <div className="feature-empty tone-empty"><span className="empty-icon goals" aria-hidden="true">I</span><h4>Build your voice fingerprint</h4><p>Iris analyzes up to 1,000 sent emails once, then stores only the compact profile.</p><button className="button primary" onClick={buildVoiceProfile} disabled={!!voiceBusy}>{voiceBusy ? "Learning…" : "Build voice profile"}</button></div>}</article>
          <article className="panel practice-panel"><div className="panel-heading"><div><p className="kicker">Tone trainer</p><h3>Which response feels most like you?</h3></div><span className="selection-progress">{trainedEmailIds.length ? `${trainedEmailIds.length} preference${trainedEmailIds.length === 1 ? "" : "s"} saved` : replies.length ? "Pick 1 of 3" : "Step 1 of 2"}</span></div>
            {!profile ? <div className="feature-empty"><span className="empty-icon" aria-hidden="true">↗</span><h4>Start with your voice profile</h4><p>Once your fingerprint is ready, Iris can create three replies for real unanswered emails.</p></div> : !voiceEmails.length ? <div className="feature-empty"><span className="empty-icon" aria-hidden="true">↗</span><h4>Find an email waiting on you</h4><p>Iris will surface a few unanswered messages. Nothing is stored.</p><button className="button primary" onClick={loadVoiceInbox} disabled={!!voiceBusy}>{voiceBusy ? "Looking…" : "Load unanswered emails"}</button></div> : <><label className="field-label" htmlFor="email-choice">Choose an unanswered email</label><select id="email-choice" className="email-select" value={selectedEmail?.id ?? ""} disabled={!!voiceBusy} onChange={(event) => { setSelectedEmail(voiceEmails.find((item) => item.id === event.target.value) ?? null); setReplies([]); setSelectedReply(null); setEmailKey(""); }}>{voiceEmails.map((item) => <option key={item.id} value={item.id}>{displayName(item.from)} — {item.subject}</option>)}</select>{selectedEmail && <div className="incoming-preview"><div className="avatar">{initials(selectedEmail.from)}</div><div><div className="email-meta"><b>{displayName(selectedEmail.from)}</b><span>{timeAgo(selectedEmail.received_at)}</span></div><strong>{selectedEmail.subject}</strong><p>{selectedEmail.preview}</p></div></div>}{!replies.length && !voiceBusy && <button className="button primary wide" onClick={generateExamples}>Generate 3 responses</button>}{voiceBusy && <BusyBlock label={voiceBusy} />}</>}
            {voiceError && <p className="inline-error" role="alert">{voiceError}</p>}
          </article>
        </div>
        {replies.length > 0 && <div className="response-stage"><div className="response-stage-heading"><div><p className="kicker">Three directions, one voice</p><h3>Choose what you would actually send</h3></div><span>Your choice updates your tone, then loads the next email</span></div><div className="response-grid">{replies.map((reply) => <button key={reply.id} className={`response-card ${reply.id} ${selectedReply === reply.id ? "selected" : ""}`} onClick={() => chooseReply(reply.id)} disabled={!!voiceBusy} aria-pressed={selectedReply === reply.id}><span className="response-label">{reply.label}<i>{reply.description}</i></span><p>{reply.email}</p><span className="choose-line">{selectedReply === reply.id ? "Selected — tone updated" : "Choose this response"}<b aria-hidden="true">→</b></span></button>)}</div></div>}
      </section>}

      {view === "importance" && <section className="product-section importance-section" id="importance" aria-labelledby="importance-title">
        <div className="section-intro"><div><span className="step-number">02</span><p className="eyebrow">Importance engine</p><h2 id="importance-title">See what matters. Skip what doesn’t.</h2><p>Set clear rules yourself, or let Iris learn your active goals from your inbox.</p></div><span className={`section-state ${importance?.profile ? "ready" : ""}`}>{importance?.profile ? "Goals active" : "Ready to learn"}</span></div>
        <article className="panel instruction-panel">
          <div className="panel-heading"><div><p className="kicker">Tell Iris directly</p><h3>What should your inbox show?</h3></div><span className="ai-badge">AI · cached inbox</span></div>
          <p className="panel-copy">Write a plain sentence. Iris turns it into account-specific ranking signals and immediately re-filters your saved inbox—no Gmail rescan.</p>
          <div className="instruction-compose"><textarea value={importanceInstruction} onChange={(event) => { setImportanceInstruction(event.target.value.slice(0, 500)); setImportanceSaved(null); }} maxLength={500} rows={3} placeholder="For example: I don’t like seeing college promotional emails." aria-label="Importance instruction" disabled={!!importanceBusy} /><div><small>{importanceInstruction.length}/500</small><button className="button primary" onClick={applyImportanceInstruction} disabled={!importanceInstruction.trim() || !!importanceBusy}>{importanceBusy === "Updating your importance rules" ? "Applying…" : "Apply to my inbox"}</button></div></div>
          {importanceSaved && <p className="instruction-saved" role="status">✓ {importanceSaved}</p>}
          {importance?.instructions.history.length ? <div className="instruction-history"><b>Recent instructions</b>{importance.instructions.history.slice(-4).reverse().map((item) => <div key={`${item.created_at}-${item.instruction}`}><span>{item.instruction}</span><small>{[...item.ignore_keywords.map((value) => `Hide: ${value}`), ...item.priority_keywords.map((value) => `Prioritize: ${value}`), ...item.vip_senders.map((value) => `VIP: ${value}`)].slice(0, 4).join(" · ")}</small></div>)}</div> : null}
          {importanceInstructionError && <p className="inline-error" role="alert">{importanceInstructionError}</p>}
        </article>
        <div className="importance-grid">
          <article className="panel rules-panel"><div className="panel-heading"><div><p className="kicker">Manual controls</p><h3>Always prioritize</h3></div>{rulesDirty && <span className="unsaved">Unsaved</span>}</div><p className="panel-copy">Tell Iris which kinds of messages should rise to the top.</p><div className="switch-grid">{CATEGORIES.map((category) => <label className="switch-row" key={category.id}><span><b>{category.label}</b><small>{category.detail}</small></span><input type="checkbox" checked={importance?.rules.categories[category.id] ?? false} onChange={(event) => importance && updateRule("categories", { ...importance.rules.categories, [category.id]: event.target.checked })} /><i aria-hidden="true" /></label>)}</div>{importance && <div className="rules-fields"><label><span>VIP senders <small>comma separated</small></span><input value={importance.rules.vip_senders.join(", ")} onChange={(event) => updateRule("vip_senders", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} placeholder="founder@company.com" /></label><label><span>Priority words <small>comma separated</small></span><input value={importance.rules.priority_keywords.join(", ")} onChange={(event) => updateRule("priority_keywords", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} placeholder="urgent, proposal, demo" /></label><label><span>Ignore words <small>comma separated</small></span><input value={importance.rules.ignore_keywords.join(", ")} onChange={(event) => updateRule("ignore_keywords", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} placeholder="newsletter, promotion" /></label></div>}<button className="button secondary wide" onClick={saveRules} disabled={!rulesDirty || !!importanceBusy}>{importanceBusy === "Saving preferences" ? "Saving…" : "Save preferences"}</button></article>
          <article className="panel goals-panel"><div className="panel-heading"><div><p className="kicker">Automatic learning</p><h3>Your goals profile</h3></div><span className="ai-badge">AI · one-time</span></div>{importance?.profile ? <><p className="goal-summary">{importance.profile.profile.summary}</p><div className="goal-list">{importance.profile.profile.goals.slice(0, 5).map((goal) => <div className="goal-row" key={goal.goal}><span className="goal-weight">{goal.weight}</span><div><b>{goal.goal}</b><small>{goal.signals.slice(0, 3).join(" · ")}</small></div></div>)}</div><div className="goal-meta"><span>{importance.profile.sampled_emails} emails analyzed</span><button onClick={() => buildGoals(true)} disabled={!!importanceBusy}>Refresh profile</button></div></> : <div className="feature-empty compact"><span className="empty-icon goals" aria-hidden="true">◎</span><h4>Let Iris learn what you’re working toward</h4><p>One focused analysis turns your inbox patterns into a reusable goals profile.</p><button className="button primary" onClick={() => buildGoals(false)} disabled={!!importanceBusy}>{importanceBusy ? "Learning…" : "Build goals profile"}</button><small>Up to 500 filtered emails · one AI call · cached locally</small></div>}{importanceBusy && importanceBusy !== "Saving preferences" && importanceBusy !== "Updating your importance rules" && <BusyBlock label={importanceBusy} />}{importanceError && <p className="inline-error" role="alert">{importanceError}</p>}</article>
        </div>
      </section>}
      <footer><span className="brand"><span className="brand-mark"><span /></span>Iris</span><p>Built to understand, not overwhelm.</p><span>Profiles stored locally</span></footer>
    </main>
  );
}
