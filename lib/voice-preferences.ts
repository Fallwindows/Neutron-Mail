import { createHash } from "node:crypto";
import { accountFilePath, legacyFilePath, readJsonFile, readOwnedAccountJson, writeAccountJson } from "./account-storage";
import { type VoiceProfile } from "./voice-profile";

export const TONE_AXES = ["warmth", "directness", "formality", "brevity", "energy"] as const;
export type ToneAxis = (typeof TONE_AXES)[number];
export type ToneVector = Record<ToneAxis, number>;
export type ResponseStyle = "direct" | "warm" | "polished";

export const STYLE_ADJUSTMENTS: Record<ResponseStyle, ToneVector> = {
  direct: { warmth: -4, directness: 14, formality: 1, brevity: 14, energy: -3 },
  warm: { warmth: 15, directness: -3, formality: -3, brevity: -4, energy: 10 },
  polished: { warmth: 3, directness: 3, formality: 15, brevity: -3, energy: -2 },
};

export type StoredTonePreferences = {
  owner_email: string;
  vector: ToneVector;
  selections: number;
  selected_email_keys?: string[];
  selected_styles?: Record<string, ResponseStyle>;
  last_selection?: ResponseStyle;
  updated_at: string;
};

export type CachedVoiceExamples = {
  owner_email: string;
  email_key: string;
  generated_at: string;
  responses?: Array<{ id: ResponseStyle; label: string; description: string; email: string }>;
  error?: string;
};

const PREFERENCES_FILENAME = "voice_preferences.json";
const EXAMPLES_FILENAME = "voice_example_cache.json";

function clamp(value: number) {
  return Math.max(5, Math.min(95, Math.round(value)));
}

function includesAny(value: string, phrases: string[]) {
  const text = value.toLowerCase();
  return phrases.some((phrase) => text.includes(phrase));
}

export function inferBaseTone(profile: VoiceProfile): ToneVector {
  const summary = [
    profile.tone,
    profile.sentence_structure,
    profile.punctuation_habits,
    profile.formality_by_relationship,
    profile.typical_length,
    profile.response_pattern,
  ].join(" ");

  return {
    warmth: includesAny(summary, ["warm", "personal", "friendly"]) ? 68 : 50,
    directness: includesAny(summary, ["direct", "to the point", "straight"]) ? 78 : 58,
    formality: includesAny(summary, ["formal", "professional", "title"]) ? 73 : 52,
    brevity: includesAny(summary, ["concise", "short", "terse"]) ? 76 : 54,
    energy: includesAny(summary, ["enthusiastic", "energetic", "exclamation"]) ? 68 : 44,
  };
}

export async function readTonePreferences(ownerEmail: string) {
  return readOwnedAccountJson<StoredTonePreferences>(ownerEmail, PREFERENCES_FILENAME);
}

export async function saveToneSelection(options: {
  ownerEmail: string;
  emailKey: string;
  style: ResponseStyle;
  base: ToneVector;
}) {
  const existing = await readTonePreferences(options.ownerEmail);
  const isOwner = existing?.owner_email.toLowerCase() === options.ownerEmail.toLowerCase();
  const ownerExisting = isOwner ? existing : null;
  const previousStyle = ownerExisting?.selected_styles?.[options.emailKey];
  if (previousStyle === options.style && ownerExisting) return ownerExisting;
  const current = ownerExisting?.vector ?? options.base;
  const adjustment = STYLE_ADJUSTMENTS[options.style];
  const previousAdjustment = previousStyle ? STYLE_ADJUSTMENTS[previousStyle] : null;
  const vector = Object.fromEntries(
    TONE_AXES.map((axis) => [
      axis,
      clamp(current[axis] - (previousAdjustment?.[axis] ?? 0) + adjustment[axis]),
    ]),
  ) as ToneVector;
  const stored: StoredTonePreferences = {
    owner_email: options.ownerEmail,
    vector,
    selections: previousStyle ? ownerExisting!.selections : ownerExisting ? ownerExisting.selections + 1 : 1,
    selected_email_keys: ownerExisting
      ? [...new Set([...(ownerExisting.selected_email_keys ?? []), options.emailKey])].slice(-200)
      : [options.emailKey],
    selected_styles: {
      ...(ownerExisting?.selected_styles ?? {}),
      [options.emailKey]: options.style,
    },
    last_selection: options.style,
    updated_at: new Date().toISOString(),
  };
  await writeAccountJson(options.ownerEmail, PREFERENCES_FILENAME, stored);
  return stored;
}

export function voiceExampleKey(ownerEmail: string, messageId: string) {
  return createHash("sha256")
    .update(ownerEmail).update("\0").update(messageId)
    .digest("hex");
}

export async function readVoiceExampleCache(ownerEmail: string) {
  const current = await readJsonFile<Record<string, CachedVoiceExamples>>(
    accountFilePath(ownerEmail, EXAMPLES_FILENAME),
  );
  if (current) return current;

  const legacy = await readJsonFile<Record<string, CachedVoiceExamples>>(legacyFilePath(EXAMPLES_FILENAME));
  if (!legacy) return {};
  const owned = Object.fromEntries(
    Object.entries(legacy).filter(([, entry]) => entry.owner_email.toLowerCase() === ownerEmail.toLowerCase()),
  );
  if (Object.keys(owned).length) await writeAccountJson(ownerEmail, EXAMPLES_FILENAME, owned);
  return owned;
}

export async function saveVoiceExampleCache(ownerEmail: string, cache: Record<string, CachedVoiceExamples>) {
  await writeAccountJson(ownerEmail, EXAMPLES_FILENAME, cache);
}

export function isResponseStyle(value: unknown): value is ResponseStyle {
  return value === "direct" || value === "warm" || value === "polished";
}
