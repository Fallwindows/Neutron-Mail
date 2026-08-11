const GMAIL_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_CANDIDATE_THREADS = 18;
const MAX_RETURNED_EMAILS = 5;
const MAX_BODY_CHARS = 6_000;

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
};

type GmailMessage = {
  id: string;
  threadId: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

type GmailThread = { id: string; messages?: GmailMessage[] };

export type UnansweredEmail = {
  id: string;
  thread_id: string;
  from: string;
  subject: string;
  received_at: string;
  preview: string;
  body: string;
};

async function gmailFetch<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gmail API request failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  return response.json() as Promise<T>;
}

function decodeBase64Url(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function header(payload: GmailPart | undefined, name: string) {
  return payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function collectBodies(part: GmailPart | undefined, mimeType: string, output: string[]) {
  if (!part) return;
  if (part.mimeType === mimeType && part.body?.data) output.push(decodeBase64Url(part.body.data));
  for (const child of part.parts ?? []) collectBodies(child, mimeType, output);
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function messageBody(payload: GmailPart | undefined) {
  const plain: string[] = [];
  collectBodies(payload, "text/plain", plain);
  if (plain.length) return plain.join("\n");
  const html: string[] = [];
  collectBodies(payload, "text/html", html);
  return htmlToText(html.join("\n"));
}

function cleanBody(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/^On .+wrote:[\s\S]*$/im, "")
    .replace(/^-{2,}\s*Original Message\s*-{2,}[\s\S]*$/im, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

function senderAddress(value: string) {
  return value.match(/<([^>]+)>/)?.[1] ?? value;
}

function isFromOwner(from: string, ownerEmail: string) {
  return senderAddress(from).trim().toLowerCase() === ownerEmail.trim().toLowerCase();
}

export async function fetchUnansweredEmails(accessToken: string, expectedEmail: string) {
  const profile = await gmailFetch<{ emailAddress: string }>(`${GMAIL_ROOT}/profile`, accessToken);
  if (profile.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error(`Gmail permission was granted for ${profile.emailAddress}, not ${expectedEmail}.`);
  }

  const listUrl = new URL(`${GMAIL_ROOT}/messages`);
  listUrl.searchParams.set("q", "in:inbox -from:me newer_than:90d");
  listUrl.searchParams.set("maxResults", String(MAX_CANDIDATE_THREADS));
  const list = await gmailFetch<{ messages?: Array<{ id: string; threadId: string }> }>(
    listUrl.toString(),
    accessToken,
  );
  const threadIds = [...new Set((list.messages ?? []).map((item) => item.threadId))]
    .slice(0, MAX_CANDIDATE_THREADS);

  const threads = new Array<GmailThread>(threadIds.length);
  let cursor = 0;
  async function worker() {
    while (cursor < threadIds.length) {
      const index = cursor++;
      const id = threadIds[index];
      threads[index] = await gmailFetch<GmailThread>(
        `${GMAIL_ROOT}/threads/${encodeURIComponent(id)}?format=full`,
        accessToken,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, threadIds.length) }, () => worker()));

  return threads
    .map((thread): UnansweredEmail | null => {
      const latest = [...(thread.messages ?? [])]
        .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0))[0];
      if (!latest) return null;
      const from = header(latest.payload, "From");
      if (!from || isFromOwner(from, expectedEmail)) return null;
      const body = cleanBody(messageBody(latest.payload));
      if (!body) return null;
      return {
        id: latest.id,
        thread_id: latest.threadId,
        from,
        subject: header(latest.payload, "Subject") || "(No subject)",
        received_at: new Date(Number(latest.internalDate ?? Date.now())).toISOString(),
        preview: (latest.snippet || body).replace(/\s+/g, " ").trim().slice(0, 180),
        body,
      };
    })
    .filter((item): item is UnansweredEmail => item !== null)
    .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at))
    .slice(0, MAX_RETURNED_EMAILS);
}
