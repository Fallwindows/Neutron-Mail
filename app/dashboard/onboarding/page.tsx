import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { OnboardingFlow } from "./onboarding-flow";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard");

  return <OnboardingFlow email={session.email} clientId={process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? ""} />;
}
