import { mkdir } from "node:fs/promises";
import { DATA_DIR, accountFilePath, readOwnedAccountJson, writeAccountJson } from "./account-storage";

export const MAX_SENT_EMAILS = 1_000;

export type VoiceProfile = {
  tone: string;
  greetings: string[];
  signoffs: string[];
  sentence_structure: string;
  punctuation_habits: string;
  common_phrases: string[];
  formality_by_relationship: string;
  typical_length: string;
  response_pattern: string;
};

export type StoredVoiceProfile = {
  owner_email: string;
  generated_at: string;
  sampled_emails: number;
  profile: VoiceProfile;
};

export { DATA_DIR } from "./account-storage";
const VOICE_PROFILE_FILENAME = "voice_profile.json";

export async function ensureDataDirectory() {
  await mkdir(DATA_DIR, { recursive: true });
}

export function rawVoiceFailureLogPath(ownerEmail: string) {
  return accountFilePath(ownerEmail, "openrouter_raw_failures.log");
}

export async function readVoiceProfile(ownerEmail: string): Promise<StoredVoiceProfile | null> {
  return readOwnedAccountJson<StoredVoiceProfile>(ownerEmail, VOICE_PROFILE_FILENAME);
}

export async function saveVoiceProfile(profile: StoredVoiceProfile) {
  await writeAccountJson(profile.owner_email, VOICE_PROFILE_FILENAME, profile);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateVoiceProfile(value: unknown): VoiceProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Voice profile must be a JSON object.");
  }

  const candidate = value as Record<string, unknown>;
  const stringFields = [
    "tone",
    "sentence_structure",
    "punctuation_habits",
    "formality_by_relationship",
    "typical_length",
    "response_pattern",
  ] as const;
  const arrayFields = ["greetings", "signoffs", "common_phrases"] as const;

  for (const field of stringFields) {
    if (typeof candidate[field] !== "string") throw new Error(`Voice profile field ${field} must be a string.`);
  }
  for (const field of arrayFields) {
    if (!isStringArray(candidate[field])) throw new Error(`Voice profile field ${field} must be a string array.`);
  }

  return {
    tone: candidate.tone as string,
    greetings: candidate.greetings as string[],
    signoffs: candidate.signoffs as string[],
    sentence_structure: candidate.sentence_structure as string,
    punctuation_habits: candidate.punctuation_habits as string,
    common_phrases: candidate.common_phrases as string[],
    formality_by_relationship: candidate.formality_by_relationship as string,
    typical_length: candidate.typical_length as string,
    response_pattern: candidate.response_pattern as string,
  };
}
