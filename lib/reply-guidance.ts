import { createHash } from "node:crypto";
import { readOwnedAccountJson, writeAccountJson } from "./account-storage";

export type ReplyLearning = {
  id: string;
  message_key: string;
  instruction: string;
  draft_hash: string;
  created_at: string;
};

export type StoredReplyLearning = {
  owner_email: string;
  updated_at: string;
  learnings: ReplyLearning[];
};

const FILENAME = "goals_reply_learning.json";
const MAX_LEARNINGS = 100;

export const readReplyLearning = (ownerEmail: string) =>
  readOwnedAccountJson<StoredReplyLearning>(ownerEmail, FILENAME);

export async function saveReplyLearning(options: { ownerEmail: string; messageId: string; instruction: string; draft: string }) {
  const existing = await readReplyLearning(options.ownerEmail);
  const createdAt = new Date().toISOString();
  const learning: ReplyLearning = {
    id: createHash("sha256").update(options.ownerEmail.toLowerCase()).update("\0").update(options.messageId).update("\0").update(options.instruction).update("\0").update(createdAt).digest("hex"),
    message_key: createHash("sha256").update(options.ownerEmail.toLowerCase()).update("\0").update(options.messageId).digest("hex"),
    instruction: options.instruction.trim(),
    draft_hash: createHash("sha256").update(options.draft.trim()).digest("hex"),
    created_at: createdAt,
  };
  const stored: StoredReplyLearning = {
    owner_email: options.ownerEmail,
    updated_at: createdAt,
    learnings: [...(existing?.learnings ?? []), learning].slice(-MAX_LEARNINGS),
  };
  await writeAccountJson(options.ownerEmail, FILENAME, stored);
  return stored;
}

export function replyLearningPrompt(learning: StoredReplyLearning | null) {
  const recent = learning?.learnings.slice(-20).map((item) => item.instruction).filter(Boolean) ?? [];
  if (!recent.length) return "No explicit reply-intent corrections have been recorded yet.";
  return `Recent explicit reply-intent corrections from this account (newest last; use only when relevant, and never copy facts between messages): ${JSON.stringify(recent)}`;
}
