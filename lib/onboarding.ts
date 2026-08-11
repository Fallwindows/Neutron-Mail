import { readOwnedAccountJson, writeAccountJson } from "./account-storage";

export type StoredOnboarding = {
  owner_email: string;
  version: number;
  completed_at: string;
};

const ONBOARDING_FILENAME = "onboarding.json";
export const ONBOARDING_VERSION = 1;

export async function readOnboarding(ownerEmail: string) {
  return readOwnedAccountJson<StoredOnboarding>(ownerEmail, ONBOARDING_FILENAME);
}

export async function completeOnboarding(ownerEmail: string) {
  const stored: StoredOnboarding = {
    owner_email: ownerEmail,
    version: ONBOARDING_VERSION,
    completed_at: new Date().toISOString(),
  };
  await writeAccountJson(ownerEmail, ONBOARDING_FILENAME, stored);
  return stored;
}
