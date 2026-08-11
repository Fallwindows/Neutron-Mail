import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { InboxDashboard } from "../../inbox-dashboard";

export const dynamic = "force-dynamic";

export default async function VoicePage() {
  const session = await getSession();
  if (!session) redirect("/dashboard");

  return <InboxDashboard email={session.email} clientId={process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? ""} view="voice" />;
}
