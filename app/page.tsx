import { getSession } from "@/lib/session";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  const dashboardLabel = session ? "Open your inbox" : "Try Iris with Google";

  return (
    <main className="landing-shell">
      <header className="topbar landing-topbar">
        <a className="brand" href="#top" aria-label="Iris home">
          <span className="brand-mark"><span /></span>
          <span>Iris</span>
        </a>
        <nav className="landing-nav" aria-label="Product navigation">
          <a href="#voice">Voice</a>
          <a href="#importance">Importance</a>
        </nav>
        <div className="landing-account">
          {session && <span>{session.email}</span>}
          <Link className="button primary compact-cta" href="/dashboard">{dashboardLabel}</Link>
        </div>
      </header>

      <section className="landing-hero" id="top">
        <div className="landing-hero-copy">
          <p className="eyebrow">Your inbox, understood</p>
          <h1>Write like yourself.<br />Focus on what matters.</h1>
          <p>Iris learns your email voice and your real priorities, then turns every inbox into a clear, personal workspace.</p>
          <div className="landing-actions">
            <Link className="button primary landing-primary" href="/dashboard">{dashboardLabel}</Link>
            <a className="text-link" href="#voice">See how it works <span aria-hidden="true">↓</span></a>
          </div>
          <p className="landing-trust"><span /> Separate workspace for every Google account · Profiles cached locally</p>
        </div>

        <div className="landing-product-preview" aria-label="Preview of the Iris dashboard">
          <div className="preview-window-bar"><i /><i /><i /><span>Iris workspace</span></div>
          <div className="preview-dashboard">
            <div className="preview-heading"><div><small>VOICE STUDIO</small><b>Your voice fingerprint</b></div><span>Profile active</span></div>
            <div className="preview-voice-grid">
              <div className="preview-radar">
                <div className="radar-ring ring-one" />
                <div className="radar-ring ring-two" />
                <div className="radar-shape" />
                <strong>Authentically you</strong>
              </div>
              <div className="preview-replies">
                <div className="mini-email"><span>Clear & direct</span><p>Thanks for sending this over. Tuesday works—let&apos;s confirm the next steps.</p></div>
                <div className="mini-email selected"><span>Warm & human</span><p>Thanks for thinking of me. I&apos;d love to continue this on Tuesday.</p><b>Selected</b></div>
                <div className="mini-email"><span>Polished & precise</span><p>Thank you for the update. Tuesday is a good fit for the follow-up.</p></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-feature-section" id="voice">
        <div className="landing-feature-copy">
          <span className="step-number landing-step">01</span>
          <p className="eyebrow">Voice studio</p>
          <h2>Your replies should sound like you—not an assistant.</h2>
          <p>Iris builds one compact profile from your sent mail. Train it further by choosing between three real replies, and watch your tone fingerprint adapt.</p>
          <Link className="button secondary" href="/dashboard">Train your voice</Link>
        </div>
        <div className="landing-feature-card voice-feature-card">
          <div className="feature-card-top"><span>Tone fingerprint</span><b>49 emails learned</b></div>
          <div className="tone-bars">
            {[['Warmth', 68], ['Directness', 78], ['Formality', 73], ['Brevity', 76], ['Energy', 44]].map(([label, value]) => (
              <div key={String(label)}><span>{label}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>
            ))}
          </div>
          <p>Every choice updates this preference layer and guides future drafts.</p>
        </div>
      </section>

      <section className="landing-feature-section importance-landing" id="importance">
        <div className="landing-feature-card importance-feature-card">
          <div className="feature-card-top"><span>Priority inbox</span><b>Scored locally</b></div>
          <div className="priority-preview-row"><em>01</em><div><b>Investor follow-up</b><span>Funding · Priority relationship</span></div><strong>92</strong></div>
          <div className="priority-preview-row"><em>02</em><div><b>Customer rollout question</b><span>Customer · Time-sensitive</span></div><strong>84</strong></div>
          <div className="priority-preview-row muted"><em>12</em><div><b>Weekly product newsletter</b><span>Likely low priority</span></div><strong>08</strong></div>
        </div>
        <div className="landing-feature-copy">
          <span className="step-number landing-step">02</span>
          <p className="eyebrow">Importance engine</p>
          <h2>Know what deserves your attention before you open it.</h2>
          <p>Choose your own priority rules or build a reusable goals profile once. Iris ranks new mail locally, with clear reasons and no per-email AI calls.</p>
          <Link className="button secondary" href="/dashboard">Set your priorities</Link>
        </div>
      </section>

      <section className="landing-final-cta">
        <p className="eyebrow">Your workspace is ready</p>
        <h2>Give your inbox a point of view.</h2>
        <p>Sign in with Google and Iris will load the private workspace connected to that account.</p>
        <Link className="button primary landing-primary" href="/dashboard">{dashboardLabel}</Link>
      </section>

      <footer className="landing-footer">
        <span className="brand"><span className="brand-mark"><span /></span>Iris</span>
        <p>Built to understand, not overwhelm.</p>
        <Link href="/dashboard">Dashboard</Link>
      </footer>
    </main>
  );
}
