import { getSession } from "@/lib/session";
import Link from "next/link";
import { AuthPanel } from "../auth-panel";
import { InboxDashboard } from "../inbox-dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

  if (session) return <InboxDashboard email={session.email} clientId={clientId} />;

  return (
    <main className="login-shell dashboard-login-shell">
      <section className="login-card" aria-labelledby="dashboard-login-title">
        <Link className="brand dashboard-login-brand" href="/" aria-label="Back to Iris home">
          <span className="brand-mark"><span /></span>
          <span>Iris</span>
        </Link>
        <p className="eyebrow">Your private workspace</p>
        <h1 id="dashboard-login-title">Open your inbox</h1>
        <p className="login-subtitle">
          Sign in with Google to start in your ranked inbox. Voice and importance setup will be there when you are ready.
        </p>
        <AuthPanel email={null} clientId={clientId} redirectTo="/dashboard" />
        <p className="privacy-note"><span aria-hidden="true">&#9679;</span> Each Google account has a separate local workspace.</p>
      </section>
    </main>
  );
}
