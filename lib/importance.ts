import { readOwnedAccountJson, writeAccountJson } from "./account-storage";
import { isUnreplyable } from "./triage";

export const MAX_GOAL_PROFILE_EMAILS = 500;
export const MAX_IMPORTANCE_INBOX_EMAILS = 100;
export const MAX_IMPORTANCE_SCAN_EMAILS = 300;
export const IMPORTANCE_CATEGORIES = ["customers", "investors", "team", "deadlines", "finance", "legal", "security", "hiring"] as const;
export type ImportanceCategory = (typeof IMPORTANCE_CATEGORIES)[number];
export type Goal = { goal: string; signals: string[]; weight: number };
export type GoalsProfile = { summary: string; goals: Goal[]; priority_people: string[]; priority_organizations: string[]; priority_topics: string[]; urgency_signals: string[]; low_priority_signals: string[] };
export type StoredGoalsProfile = { owner_email: string; generated_at: string; sampled_emails: number; profile: GoalsProfile };
export type ImportanceRules = { owner_email: string; updated_at: string; categories: Record<ImportanceCategory, boolean>; vip_senders: string[]; priority_keywords: string[]; ignore_keywords: string[] };
type ImportanceInstructionSignals = {
  ignore_keywords: string[];
  priority_keywords: string[];
  vip_senders: string[];
};
export type ImportanceInstructionChange = ImportanceInstructionSignals & {
  remove_ignore_keywords: string[];
  remove_priority_keywords: string[];
  remove_vip_senders: string[];
};
export type ImportanceInstruction = ImportanceInstructionChange & { instruction: string; created_at: string };
export type ImportanceInstructionStore = ImportanceInstructionSignals & { owner_email: string; updated_at: string; history: ImportanceInstruction[] };

const PROFILE_FILENAME = "goals_profile.json";
const RULES_FILENAME = "importance_rules.json";
const INSTRUCTIONS_FILENAME = "importance_instructions.json";

export function defaultRules(ownerEmail: string): ImportanceRules { return { owner_email: ownerEmail, updated_at: new Date(0).toISOString(), categories: Object.fromEntries(IMPORTANCE_CATEGORIES.map((name) => [name, false])) as Record<ImportanceCategory, boolean>, vip_senders: [], priority_keywords: [], ignore_keywords: [] }; }
export const readGoalsProfile = (ownerEmail: string) => readOwnedAccountJson<StoredGoalsProfile>(ownerEmail, PROFILE_FILENAME);
export const saveGoalsProfile = (value: StoredGoalsProfile) => writeAccountJson(value.owner_email, PROFILE_FILENAME, value);
export async function readImportanceRules(ownerEmail: string) { return (await readOwnedAccountJson<ImportanceRules>(ownerEmail, RULES_FILENAME)) ?? defaultRules(ownerEmail); }
export const saveImportanceRules = (value: ImportanceRules) => writeAccountJson(value.owner_email, RULES_FILENAME, value);
export function defaultImportanceInstructions(ownerEmail: string): ImportanceInstructionStore { return { owner_email: ownerEmail, updated_at: new Date(0).toISOString(), ignore_keywords: [], priority_keywords: [], vip_senders: [], history: [] }; }
export async function readImportanceInstructions(ownerEmail: string) {
  const stored = await readOwnedAccountJson<Partial<ImportanceInstructionStore> & { owner_email: string }>(ownerEmail, INSTRUCTIONS_FILENAME);
  if (!stored) return defaultImportanceInstructions(ownerEmail);
  const history = Array.isArray(stored.history) ? stored.history.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Partial<ImportanceInstruction>;
    if (typeof item.instruction !== "string" || typeof item.created_at !== "string") return [];
    return [{ instruction: item.instruction.slice(0, 500), created_at: item.created_at, ignore_keywords: cleanList(item.ignore_keywords, 20), priority_keywords: cleanList(item.priority_keywords, 20), vip_senders: cleanList(item.vip_senders, 20), remove_ignore_keywords: cleanList(item.remove_ignore_keywords, 20), remove_priority_keywords: cleanList(item.remove_priority_keywords, 20), remove_vip_senders: cleanList(item.remove_vip_senders, 20) }];
  }).slice(-30) : [];
  return { owner_email: ownerEmail, updated_at: typeof stored.updated_at === "string" ? stored.updated_at : new Date(0).toISOString(), ignore_keywords: cleanList(stored.ignore_keywords, 60), priority_keywords: cleanList(stored.priority_keywords, 60), vip_senders: cleanList(stored.vip_senders, 60), history } satisfies ImportanceInstructionStore;
}
export const saveImportanceInstructions = (value: ImportanceInstructionStore) => writeAccountJson(value.owner_email, INSTRUCTIONS_FILENAME, value);
export async function readEffectiveImportanceRules(ownerEmail: string) {
  const [rules, learned] = await Promise.all([readImportanceRules(ownerEmail), readImportanceInstructions(ownerEmail)]);
  return { ...rules, vip_senders: mergeSignals(rules.vip_senders, learned.vip_senders, 90), priority_keywords: mergeSignals(rules.priority_keywords, learned.priority_keywords, 90), ignore_keywords: mergeSignals(rules.ignore_keywords, learned.ignore_keywords, 90) };
}

function compactStrings(value: unknown, max = 12) { if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("Expected a string array."); return [...new Set(value.map((item) => item.trim()).filter(Boolean))].slice(0, max); }
export function validateGoalsProfile(value: unknown): GoalsProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Goals profile must be a JSON object.");
  const item = value as Record<string, unknown>;
  if (typeof item.summary !== "string" || !Array.isArray(item.goals)) throw new Error("Goals profile has invalid summary or goals.");
  const goals = item.goals.slice(0, 8).map((raw) => { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid goal entry."); const goal = raw as Record<string, unknown>; if (typeof goal.goal !== "string" || typeof goal.weight !== "number") throw new Error("Invalid goal fields."); return { goal: goal.goal.trim().slice(0, 160), signals: compactStrings(goal.signals, 10), weight: Math.max(1, Math.min(5, Math.round(goal.weight))) }; });
  return { summary: item.summary.trim().slice(0, 500), goals, priority_people: compactStrings(item.priority_people), priority_organizations: compactStrings(item.priority_organizations), priority_topics: compactStrings(item.priority_topics), urgency_signals: compactStrings(item.urgency_signals), low_priority_signals: compactStrings(item.low_priority_signals) };
}
function cleanList(value: unknown, max: number) { if (!Array.isArray(value)) return []; return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, max); }
function mergeSignals(left: string[], right: string[], max: number) { return [...new Set([...left, ...right])].slice(0, max); }
export function validateImportanceInstructionChange(value: unknown): ImportanceInstructionChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Importance instruction result must be a JSON object.");
  const item = value as Record<string, unknown>;
  const generic = new Set(["email", "emails", "message", "messages", "important", "unimportant", "good", "bad"]);
  const safe = (input: unknown) => cleanList(input, 12).filter((term) => term.length >= 2 && term.length <= 100 && !/[\r\n<>]/.test(term) && !generic.has(term));
  const result = {
    ignore_keywords: safe(item.ignore_keywords),
    priority_keywords: safe(item.priority_keywords),
    vip_senders: safe(item.vip_senders),
    remove_ignore_keywords: safe(item.remove_ignore_keywords),
    remove_priority_keywords: safe(item.remove_priority_keywords),
    remove_vip_senders: safe(item.remove_vip_senders),
  };
  if (!Object.values(result).some((values) => values.length)) throw new Error("That instruction did not contain a usable email preference.");
  return result;
}
export function validateRules(value: unknown, ownerEmail: string): ImportanceRules { const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; const categoriesInput = input.categories && typeof input.categories === "object" ? input.categories as Record<string, unknown> : {}; return { owner_email: ownerEmail, updated_at: new Date().toISOString(), categories: Object.fromEntries(IMPORTANCE_CATEGORIES.map((name) => [name, categoriesInput[name] === true])) as Record<ImportanceCategory, boolean>, vip_senders: cleanList(input.vip_senders, 30), priority_keywords: cleanList(input.priority_keywords, 30), ignore_keywords: cleanList(input.ignore_keywords, 30) }; }

export type ScorableEmail = { id: string; thread_id: string; rfc_message_id: string; sender: string; reply_to?: string; subject: string; snippet: string; body: string; received_at: string; unread: boolean; gmail_labels?: string[]; list_unsubscribe?: boolean; bulk_precedence?: boolean; importance_score?: number; needs_reply_score?: number; needs_reply?: boolean; triage_reason?: string };
export type ScoredEmail = Omit<ScorableEmail, "body"> & { important: boolean; importance_score: number; needs_reply_score?: number; needs_reply?: boolean; score: number; reasons: string[] };
export type CachedRankedEmail = ScoredEmail & { body: string };
export type RankedInboxCache = { schema_version?: 2; owner_email: string; scanned_at: string; source_message_count: number; source_emails?: ScorableEmail[]; emails: CachedRankedEmail[] };
const RANKED_INBOX_FILENAME = "ranked_inbox.json";
export const readRankedInboxCache = (ownerEmail: string) => readOwnedAccountJson<RankedInboxCache>(ownerEmail, RANKED_INBOX_FILENAME);
export function saveRankedInboxCache(ownerEmail: string, sourceMessageCount: number, emails: CachedRankedEmail[], scannedAt = new Date().toISOString(), sourceEmails: ScorableEmail[] = emails) {
  return writeAccountJson(ownerEmail, RANKED_INBOX_FILENAME, {
    schema_version: 2,
    owner_email: ownerEmail,
    scanned_at: scannedAt,
    source_message_count: sourceMessageCount,
    source_emails: sourceEmails.slice(0, MAX_IMPORTANCE_SCAN_EMAILS),
    emails: emails.slice(0, MAX_IMPORTANCE_INBOX_EMAILS),
  } satisfies RankedInboxCache);
}
const CATEGORY_TERMS: Record<ImportanceCategory, string[]> = { customers: ["customer", "client", "demo", "proposal", "contract", "support"], investors: ["investor", "funding", "venture", "capital", "term sheet", "pitch"], team: ["team", "project", "standup", "blocker", "milestone"], deadlines: ["deadline", "due", "by tomorrow", "eod", "action required"], finance: ["invoice", "payment", "billing", "bank", "tax", "receipt"], legal: ["legal", "agreement", "nda", "compliance", "signature"], security: ["security", "password", "breach", "suspicious", "verify", "2fa"], hiring: ["candidate", "interview", "resume", "recruit", "hiring"] };
export function scoreEmails(emails: ScorableEmail[], profile: GoalsProfile | null, rules: ImportanceRules): ScoredEmail[] {
  const operationalTerms = ["security alert", "verification code", "password reset", "invoice", "payment due", "receipt", "order confirmation", "shipment", "legal notice", "contract", "interview", "calendar invitation", "action required", "application status", "application deadline", "admissions deadline", "decision available", "missing document", "financial aid award", "deposit deadline"];
  const promotionTerms = ["unsubscribe", "manage preferences", "view in browser", "special offer", "limited time", "sale ends", "% off", "discount", "promo code", "shop now", "free shipping", "weekly deals", "newsletter", "exclusive offer"];
  const collegeMarketingTerms = ["apply now", "request information", "request info", "degree program", "graduate program", "online degree", "explore our programs", "schedule a campus tour", "visit campus", "enrollment counselor", "admissions event", "open house", "start your application", "continue your application"];
  const directCues = ["can you", "could you", "please reply", "please send", "let me know", "are you available", "would you be able", "what do you think"];
  const ranked = emails.flatMap((email) => {
    const text = `${email.sender}\n${email.subject}\n${email.snippet}\n${email.body}`.toLowerCase();
    const hit = (terms: string[]) => terms.filter((term) => term && text.includes(term.toLowerCase()));
    if (hit(rules.ignore_keywords).length) return [];
    const vip = hit(rules.vip_senders);
    const priority = hit(rules.priority_keywords);
    const goalHits = profile?.goals.filter((goal) => hit([goal.goal, ...goal.signals]).length) ?? [];
    const relationshipHit = profile ? hit([...profile.priority_people, ...profile.priority_organizations]) : [];
    const operational = hit(operationalTerms).length > 0;
    const labels = new Set(email.gmail_labels ?? []);
    const bulk = email.list_unsubscribe === true || email.bulk_precedence === true || labels.has("CATEGORY_PROMOTIONS") || /\bunsubscribe\b|manage (?:email )?preferences|view (?:this email )?in (?:your )?browser/i.test(text);
    const collegeMarketing = hit(collegeMarketingTerms).length > 0 || (/\b(?:college|university|admissions?|enrollment|degree)\b/.test(text) && hit(["apply", "program", "campus", "learn more", "register now"]).length >= 2);
    const marketing = hit(promotionTerms).length >= 2;
    const explicitlyProtected = vip.length > 0 || priority.length > 0;
    const learnedRelevant = goalHits.length > 0 || relationshipHit.length > 0;
    const modeled = Number.isInteger(email.importance_score) && Number.isInteger(email.needs_reply_score);
    const modeledRelevant = modeled && (email.importance_score! >= 40 || email.needs_reply_score! >= 70);
    const humanSender = !/(?:no-?reply|do-?not-?reply|newsletter|marketing|promotions?|admissions?|enrollment|info)@/i.test(email.sender);
    const direct = !bulk && humanSender && (/^(?:re|fwd?):/i.test(email.subject.trim()) || hit(directCues).length > 0);
    if ((bulk || marketing || collegeMarketing) && !operational && !explicitlyProtected && !modeledRelevant) return [];

    let score = email.unread ? 4 : 0;
    const reasons: string[] = email.triage_reason ? [email.triage_reason] : [];
    if (labels.has("IMPORTANT")) { score += 32; reasons.push("Marked important by Gmail"); }
    if (labels.has("CATEGORY_PERSONAL")) { score += 18; reasons.push("Personal message"); }
    if (direct) { score += 22; reasons.push("Direct reply or action requested"); }
    if (operational) { score += 30; reasons.push("Operational or deadline notice"); }
    if (vip.length) { score += 55; reasons.push("VIP sender"); }
    if (priority.length) { score += Math.min(40, priority.length * 18); reasons.push(`Priority keyword: ${priority[0]}`); }
    for (const category of IMPORTANCE_CATEGORIES) if (rules.categories[category] && hit(CATEGORY_TERMS[category]).length) { score += 24; reasons.push(category[0].toUpperCase() + category.slice(1)); }
    for (const goal of goalHits) { score += goal.weight * 7; reasons.push(`Goal: ${goal.goal}`); }
    if (relationshipHit.length) { score += 35; reasons.push("Priority relationship"); }
    if (profile) {
      if (hit(profile.priority_topics).length) { score += 18; reasons.push("Priority topic"); }
      if (hit(profile.urgency_signals).length) { score += 16; reasons.push("Time-sensitive"); }
      if (hit(profile.low_priority_signals).length) { score -= 24; reasons.push("Likely low priority"); }
    }
    score = Math.max(0, Math.min(100, score));
    if (modeled) {
      score = email.importance_score!;
      if (operational) score = Math.max(score, 90);
      if (vip.length) score = Math.max(score, 92);
      if (priority.length) score = Math.max(score, 75);
      if (goalHits.length || relationshipHit.length || (profile && hit(profile.priority_topics).length)) score += 8;
      if (labels.has("IMPORTANT")) score += 5;
      if (profile && hit(profile.low_priority_signals).length) score -= 10;
      score = Math.max(0, Math.min(100, score));
    }
    const needsReplyScore = modeled ? (isUnreplyable(email) ? 0 : email.needs_reply_score!) : undefined;
    const needsReply = needsReplyScore === undefined ? undefined : needsReplyScore >= 70;
    const actionable = modeled
      ? score >= 40 || needsReply === true || operational || explicitlyProtected
      : operational || explicitlyProtected || learnedRelevant || direct || labels.has("IMPORTANT") || (labels.has("CATEGORY_PERSONAL") && score >= 22);
    if (!actionable || score < 18) return [];
    return [{ ...email, score, importance_score: score, needs_reply_score: needsReplyScore, needs_reply: needsReply, important: modeled ? score >= 70 : operational || explicitlyProtected || learnedRelevant || score >= 30, reasons: reasons.slice(0, 4) }];
  });
  return ranked.sort((a, b) => Number(b.needs_reply === true) - Number(a.needs_reply === true) || b.score - a.score);
}
