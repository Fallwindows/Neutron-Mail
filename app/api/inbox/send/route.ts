import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { withFileLock } from "@/lib/file-lock";
import { resolveGoogleAccessToken } from "@/lib/google-connection";
import { readRankedInboxCache, saveRankedInboxCache } from "@/lib/importance";
import { readSentReplies, saveSentReplies, type SentReply } from "@/lib/inbox-send-state";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function json(body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function emailAddress(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
}

function encodedSubject(value: string) {
  const subject = /^re:/i.test(value.trim()) ? value.trim() : `Re: ${value.trim() || "(No subject)"}`;
  return `=?UTF-8?B?${Buffer.from(subject.slice(0, 500), "utf8").toString("base64")}?=`;
}

function idempotencyKey(ownerEmail: string, sourceMessageId: string, text: string) {
  return createHash("sha256")
    .update(ownerEmail.trim().toLowerCase())
    .update("\0")
    .update(sourceMessageId)
    .update("\0")
    .update(text.trim().replace(/\r\n/g, "\n"))
    .digest("hex");
}

async function removeFromInboxCache(ownerEmail: string, sourceMessageId: string) {
  const cached = await readRankedInboxCache(ownerEmail);
  if (!cached) return;
  const sourceEmails = (cached.source_emails ?? cached.emails).filter((email) => email.id !== sourceMessageId);
  const ranked = cached.emails.filter((email) => email.id !== sourceMessageId);
  await saveRankedInboxCache(ownerEmail, cached.source_message_count, ranked, cached.scanned_at, sourceEmails);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });

  let body: { access_token?: unknown; message_id?: unknown; text?: unknown };
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, { status: 400 }); }
  if (body.access_token !== undefined && (typeof body.access_token !== "string" || body.access_token.length > 4096)) return json({ error: "A valid Gmail access token is required." }, { status: 400 });
  if (typeof body.message_id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(body.message_id)) return json({ error: "A valid cached message is required." }, { status: 400 });
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 20_000) return json({ error: "Reply text must be between 1 and 20,000 characters." }, { status: 400 });

  const sourceMessageId = body.message_id;
  const replyText = body.text.trim();
  const key = idempotencyKey(session.email, sourceMessageId, replyText);

  try {
    await ensureAccountDataDirectory(session.email);
    return await withFileLock(accountLockPath(session.email, "gmail_send.lock"), async () => {
      const sentStore = await readSentReplies(session.email);
      const prior = sentStore.replies.find((reply) => reply.idempotency_key === key);
      if (prior?.status === "sent") {
        await removeFromInboxCache(session.email, sourceMessageId);
        return json({ sent: true, duplicate: true, message_id: prior.sent_message_id, thread_id: prior.thread_id });
      }
      if (prior?.status === "pending") {
        return json({ error: "This reply was already submitted and its Gmail status is still uncertain. Iris blocked a retry to prevent a duplicate email." }, { status: 409 });
      }

      const cached = await readRankedInboxCache(session.email);
      const selected = cached?.emails.find((email) => email.id === sourceMessageId);
      if (!selected) return json({ error: "This email is no longer in the saved inbox scan. Refresh the inbox before replying." }, { status: 409 });

      const recipient = emailAddress(selected.reply_to ?? "") || emailAddress(selected.sender);
      if (!recipient) return json({ error: "The cached email does not have a valid Reply-To or From address." }, { status: 400 });
      const threadId = /^[A-Za-z0-9_-]+$/.test(selected.thread_id) ? selected.thread_id : undefined;
      const reference = /^<[^<>\r\n]+>$/.test(selected.rfc_message_id.trim()) ? selected.rfc_message_id.trim() : undefined;
      const accessToken = await resolveGoogleAccessToken(session.email, body.access_token);
      const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!profileResponse.ok) throw new Error(`Gmail profile verification failed (${profileResponse.status}).`);
      const profile = await profileResponse.json() as { emailAddress?: string };
      if (profile.emailAddress?.toLowerCase() !== session.email.toLowerCase()) throw new Error(`Gmail permission belongs to ${profile.emailAddress ?? "another account"}, not ${session.email}.`);

      const pending: SentReply = { idempotency_key: key, source_message_id: sourceMessageId, sent_message_id: null, thread_id: threadId ?? null, recipient, sent_at: new Date().toISOString(), status: "pending" };
      sentStore.replies.push(pending);
      await saveSentReplies(sentStore);

      const headers = [
        `To: ${recipient}`,
        `Subject: ${encodedSubject(selected.subject)}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        ...(reference ? [`In-Reply-To: ${reference}`, `References: ${reference}`] : []),
      ];
      const mime = `${headers.join("\r\n")}\r\n\r\n${replyText.replace(/\r?\n/g, "\r\n")}`;
      const raw = Buffer.from(mime, "utf8").toString("base64url");
      const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!sendResponse.ok) {
        sentStore.replies = sentStore.replies.filter((reply) => reply.idempotency_key !== key);
        await saveSentReplies(sentStore);
        const detail = await sendResponse.text().catch(() => "");
        throw new Error(`Gmail could not send this reply (${sendResponse.status}). ${detail.slice(0, 240)}`);
      }

      const sent = await sendResponse.json() as { id?: string; threadId?: string };
      pending.status = "sent";
      pending.sent_message_id = sent.id ?? null;
      pending.thread_id = sent.threadId ?? threadId ?? null;
      pending.sent_at = new Date().toISOString();
      await saveSentReplies(sentStore);
      await removeFromInboxCache(session.email, sourceMessageId);
      return json({ sent: true, duplicate: false, message_id: pending.sent_message_id, thread_id: pending.thread_id });
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not send this reply." }, { status: 400 });
  }
}
