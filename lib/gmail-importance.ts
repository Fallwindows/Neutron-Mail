import { MAX_GOAL_PROFILE_EMAILS, ScorableEmail } from "./importance";
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Array<{ name?: string; value?: string }> };
type Message = { id: string; threadId?: string; internalDate?: string; labelIds?: string[]; snippet?: string; payload?: Part };
type MessageList = { messages?: Array<{ id: string }>; nextPageToken?: string };
const GMAIL_PAGE_SIZE = 500;
const GMAIL_FETCH_CONCURRENCY = 10;
const GOALS_PROMPT_MAX_CHARS = 1_500_000;
const KNOWN_CONTACT_SCAN_LIMIT = 300;
async function gmail<T>(url: string, token: string): Promise<T> { const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`Gmail API request failed (${response.status}).`); return response.json() as Promise<T>; }
function decode(value: string) { return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
function header(part: Part | undefined, name: string) { return part?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? ""; }
function collect(part: Part | undefined, mime: string, out: string[]) { if (!part) return; if (part.mimeType === mime && part.body?.data) out.push(decode(part.body.data)); for (const child of part.parts ?? []) collect(child, mime, out); }
function messageBody(part: Part | undefined) { const plain: string[] = []; collect(part, "text/plain", plain); const html: string[] = []; if (!plain.length) collect(part, "text/html", html); const source = plain.length ? plain.join("\n") : html.join("\n").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&"); const value = source.replace(/\r/g, "").split(/\nOn .+wrote:|\n-{2,}\s*Original Message/im)[0]; return value.replace(/^>.*$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4_000); }
async function listInboxMessageIds(token: string, limit: number) {
  const ids: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", "in:inbox -in:spam -in:trash");
    url.searchParams.set("maxResults", String(Math.min(GMAIL_PAGE_SIZE, limit - ids.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await gmail<MessageList>(url.toString(), token);
    ids.push(...(page.messages ?? []).slice(0, limit - ids.length));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < limit);
  return ids;
}

function extractAddresses(value: string) {
  return [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((match) => match[0].toLowerCase());
}

export async function fetchSentKnownContacts(token: string, expectedEmail: string) {
  const profile = await gmail<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", token);
  if (profile.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()) throw new Error(`Gmail permission belongs to ${profile.emailAddress}, not ${expectedEmail}.`);
  const ids: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  do {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", "in:sent");
    listUrl.searchParams.set("maxResults", String(Math.min(GMAIL_PAGE_SIZE, KNOWN_CONTACT_SCAN_LIMIT - ids.length)));
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
    const page = await gmail<MessageList>(listUrl.toString(), token);
    ids.push(...(page.messages ?? []).slice(0, KNOWN_CONTACT_SCAN_LIMIT - ids.length));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < KNOWN_CONTACT_SCAN_LIMIT);
  const contacts = new Set<string>();
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const index = next++;
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(ids[index].id)}`);
      url.searchParams.set("format", "metadata");
      for (const name of ["To", "Cc", "Bcc"]) url.searchParams.append("metadataHeaders", name);
      const message = await gmail<Message>(url.toString(), token);
      for (const name of ["to", "cc", "bcc"]) for (const address of extractAddresses(header(message.payload, name))) contacts.add(address);
    }
  }
  await Promise.all(Array.from({ length: Math.min(GMAIL_FETCH_CONCURRENCY, ids.length) }, () => worker()));
  contacts.delete(expectedEmail.toLowerCase());
  return contacts;
}
export async function fetchInboxEmails(token: string, expectedEmail: string, limit = MAX_GOAL_PROFILE_EMAILS): Promise<ScorableEmail[]> {
  const profile = await gmail<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile", token); if (profile.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()) throw new Error(`Gmail permission belongs to ${profile.emailAddress}, not ${expectedEmail}.`);
  const capped = Math.min(MAX_GOAL_PROFILE_EMAILS, Math.max(1, limit)); const ids = await listInboxMessageIds(token, capped); const messages = new Array<Message>(ids.length); let next = 0; async function worker() { while (next < ids.length) { const index = next++; messages[index] = await gmail<Message>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(ids[index].id)}?format=full`, token); } } await Promise.all(Array.from({ length: Math.min(GMAIL_FETCH_CONCURRENCY, ids.length) }, () => worker()));
  return messages.filter((message) => !["SPAM", "TRASH"].some((label) => message.labelIds?.includes(label))).map((message) => ({ id: message.id, thread_id: message.threadId ?? "", rfc_message_id: header(message.payload, "message-id").slice(0, 500), sender: header(message.payload, "from").slice(0, 300), reply_to: header(message.payload, "reply-to").slice(0, 300), subject: header(message.payload, "subject").slice(0, 500), snippet: (message.snippet ?? "").slice(0, 300), body: messageBody(message.payload), received_at: new Date(Number(message.internalDate ?? Date.now())).toISOString(), unread: message.labelIds?.includes("UNREAD") ?? false, gmail_labels: message.labelIds ?? [], list_unsubscribe: Boolean(header(message.payload, "list-unsubscribe")), bulk_precedence: /\b(?:bulk|list|junk)\b/i.test(header(message.payload, "precedence")) }));
}
export function buildGoalsPrompt(emails: ScorableEmail[]) { const selected = emails.slice(0, MAX_GOAL_PROFILE_EMAILS); const bodyBudget = Math.max(400, Math.floor((GOALS_PROMPT_MAX_CHARS - selected.length * 600) / Math.max(1, selected.length))); const blocks = selected.map((email, index) => `EMAIL ${index + 1}\nFrom: ${email.sender.slice(0, 200)}\nSubject: ${email.subject.slice(0, 300)}\nBody: ${email.body.slice(0, bodyBudget)}`); return `Infer the account owner's active goals and email-priority signals from every inbox sample below. Do not summarize individual emails. Return ONLY compact valid JSON, no prose or markdown, with exactly this structure:\n{"summary":"","goals":[{"goal":"","signals":[],"weight":1}],"priority_people":[],"priority_organizations":[],"priority_topics":[],"urgency_signals":[],"low_priority_signals":[]}\nWeights are integers 1-5. Include only well-supported patterns, at most 8 goals and 12 items per list. Treat bulk marketing and newsletters as low priority if any remain.\n\n${blocks.join("\n\n---\n\n")}`.slice(0, GOALS_PROMPT_MAX_CHARS); }
