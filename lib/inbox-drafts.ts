import { createHash } from "node:crypto";
import { accountFilePath, readJsonFile, readOwnedAccountJson, writeAccountJson } from "./account-storage";

export type DraftAttempt = {
  status: "started" | "success" | "error";
  generated_at: string;
  draft?: string;
  responses?: string[];
  error?: string;
};

export type InboxDraftEntry = {
  owner_email: string;
  email_key: string;
  primary?: DraftAttempt;
  alternatives?: DraftAttempt;
};

export type InboxDraftCache = Record<string, InboxDraftEntry>;

export type TasteFeatures = {
  warmth: number;
  directness: number;
  formality: number;
  brevity: number;
  energy: number;
  word_count: number;
  greeting: "named" | "simple" | "none";
  signoff: "warm" | "formal" | "none";
};

type TasteDecision = {
  features: TasteFeatures;
  source: "generated" | "edited";
  response_hash: string;
  updated_at: string;
};

export type StoredResponseTaste = {
  owner_email: string;
  updated_at: string;
  decisions: Record<string, TasteDecision>;
  preferences: TasteFeatures;
};

const CACHE_FILENAME = "inbox_draft_cache.json";
const TASTE_FILENAME = "response_taste.json";

const clamp = (value: number) => Math.max(5, Math.min(95, Math.round(value)));

export function inboxEmailKey(ownerEmail: string, messageId: string) {
  return createHash("sha256").update(ownerEmail.trim().toLowerCase()).update("\0").update(messageId).digest("hex");
}

export async function readInboxDraftCache(ownerEmail: string): Promise<InboxDraftCache> {
  return (await readJsonFile<InboxDraftCache>(accountFilePath(ownerEmail, CACHE_FILENAME))) ?? {};
}

export async function saveInboxDraftCache(ownerEmail: string, cache: InboxDraftCache) {
  await writeAccountJson(ownerEmail, CACHE_FILENAME, cache);
}

export async function readResponseTaste(ownerEmail: string) {
  return readOwnedAccountJson<StoredResponseTaste>(ownerEmail, TASTE_FILENAME);
}

function has(text: string, expressions: RegExp[]) {
  return expressions.some((expression) => expression.test(text));
}

export function deriveTasteFeatures(text: string): TasteFeatures {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const words = trimmed.match(/[\p{L}\p{N}'-]+/gu) ?? [];
  const sentences = trimmed.split(/[.!?]+(?:\s|$)/).filter((item) => item.trim());
  const averageSentence = words.length / Math.max(1, sentences.length);
  const firstLine = lower.split(/\r?\n/)[0] ?? "";
  const lastLines = lower.split(/\r?\n/).slice(-3).join(" ");
  const namedGreeting = /^(dear|hi|hello|hey)\s+[^,\n]{2,},?/.test(firstLine);
  const simpleGreeting = /^(hi|hello|hey|good (morning|afternoon|evening))[,!]?\s*$/.test(firstLine);
  const warmSignoff = has(lastLines, [/\bthanks(?: again)?\b/, /\bbest\b/, /\bcheers\b/, /\btake care\b/]);
  const formalSignoff = has(lastLines, [/\bbest regards\b/, /\bkind regards\b/, /\bsincerely\b/, /\brespectfully\b/]);
  const warmWords = (lower.match(/\b(thanks?|appreciate|glad|happy|please|love|wonderful)\b/g) ?? []).length;
  const hedges = (lower.match(/\b(maybe|perhaps|possibly|i think|i believe|would you mind)\b/g) ?? []).length;
  const directWords = (lower.match(/\b(need|please|will|can you|by (?:today|tomorrow|monday|tuesday|wednesday|thursday|friday))\b/g) ?? []).length;
  const formalWords = (lower.match(/\b(regarding|therefore|accordingly|sincerely|respectfully|would appreciate)\b/g) ?? []).length;
  const casualWords = (lower.match(/\b(hey|yep|yeah|awesome|cool|quick|cheers)\b/g) ?? []).length;
  const exclamations = (trimmed.match(/!/g) ?? []).length;
  const questions = (trimmed.match(/\?/g) ?? []).length;
  return {
    warmth: clamp(46 + warmWords * 7 + (warmSignoff ? 8 : 0)),
    directness: clamp(58 + directWords * 5 - hedges * 7 - questions * 2),
    formality: clamp(56 + formalWords * 8 + (formalSignoff ? 12 : 0) - casualWords * 8),
    brevity: clamp(88 - Math.min(70, words.length * 0.55) + (averageSentence <= 15 ? 7 : -5)),
    energy: clamp(42 + exclamations * 12 + casualWords * 5 + warmWords * 3),
    word_count: Math.min(500, words.length),
    greeting: namedGreeting ? "named" : simpleGreeting ? "simple" : "none",
    signoff: formalSignoff ? "formal" : warmSignoff ? "warm" : "none",
  };
}

function aggregate(decisions: Record<string, TasteDecision>): TasteFeatures {
  const items = Object.values(decisions);
  const numeric = ["warmth", "directness", "formality", "brevity", "energy", "word_count"] as const;
  const average = Object.fromEntries(numeric.map((key) => [key, Math.round(items.reduce((sum, item) => sum + item.features[key], 0) / items.length)]));
  const mode = <T extends string>(key: "greeting" | "signoff") => {
    const counts = new Map<T, number>();
    for (const item of items) counts.set(item.features[key] as T, (counts.get(item.features[key] as T) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0][0];
  };
  return { ...average, greeting: mode<TasteFeatures["greeting"]>("greeting"), signoff: mode<TasteFeatures["signoff"]>("signoff") } as TasteFeatures;
}

export async function saveResponseTaste(options: {
  ownerEmail: string;
  messageId: string;
  text: string;
  source: "generated" | "edited";
}) {
  const existing = await readResponseTaste(options.ownerEmail);
  const emailKey = inboxEmailKey(options.ownerEmail, options.messageId);
  const decisions = { ...(existing?.decisions ?? {}) };
  decisions[emailKey] = {
    features: deriveTasteFeatures(options.text),
    source: options.source,
    response_hash: createHash("sha256").update(options.text.trim()).digest("hex"),
    updated_at: new Date().toISOString(),
  };
  const limited = Object.fromEntries(Object.entries(decisions).slice(-200));
  const stored: StoredResponseTaste = {
    owner_email: options.ownerEmail,
    updated_at: new Date().toISOString(),
    decisions: limited,
    preferences: aggregate(limited),
  };
  await writeAccountJson(options.ownerEmail, TASTE_FILENAME, stored);
  return stored;
}

export function tastePrompt(taste: StoredResponseTaste | null) {
  if (!taste) return "No inbox response taste decisions have been recorded yet.";
  const { warmth, directness, formality, brevity, energy, word_count, greeting, signoff } = taste.preferences;
  return `Learned response taste (deterministic, 0-100): warmth ${warmth}, directness ${directness}, formality ${formality}, brevity ${brevity}, energy ${energy}; target about ${word_count} words; greeting ${greeting}; signoff ${signoff}.`;
}
