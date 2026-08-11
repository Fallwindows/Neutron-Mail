import { readOwnedAccountJson, writeAccountJson } from "./account-storage";

const SENT_REPLIES_FILENAME = "sent_replies.json";

export type SentReply = {
  idempotency_key: string;
  source_message_id: string;
  sent_message_id: string | null;
  thread_id: string | null;
  recipient: string;
  sent_at: string;
  status: "pending" | "sent";
};

export type SentReplyStore = { owner_email: string; updated_at: string; replies: SentReply[] };

export async function readSentReplies(ownerEmail: string): Promise<SentReplyStore> {
  return (await readOwnedAccountJson<SentReplyStore>(ownerEmail, SENT_REPLIES_FILENAME)) ?? {
    owner_email: ownerEmail,
    updated_at: new Date(0).toISOString(),
    replies: [],
  };
}

export async function saveSentReplies(store: SentReplyStore) {
  store.updated_at = new Date().toISOString();
  store.replies = store.replies.slice(-500);
  await writeAccountJson(store.owner_email, SENT_REPLIES_FILENAME, store);
}

export async function submittedSourceMessageIds(ownerEmail: string) {
  const store = await readSentReplies(ownerEmail);
  return new Set(store.replies.map((reply) => reply.source_message_id));
}
