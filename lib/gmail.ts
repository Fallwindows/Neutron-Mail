import { MAX_SENT_EMAILS } from "./voice-profile";

const MAX_EMAIL_CHARS = 6_000;
const MAX_COMBINED_CHARS = 1_500_000;
const GMAIL_LIST_PAGE_SIZE = 500;
const GMAIL_FETCH_CONCURRENCY = 10;

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
};

type GmailMessage = { id: string; internalDate?: string; payload?: GmailPart };
type MessageList = { messages?: Array<{ id: string }>; nextPageToken?: string };
export type EmailSample = { recipient: string; body: string };

async function gmailFetch<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gmail API request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

function decodeBase64Url(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
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

function getMessageBody(payload: GmailPart | undefined) {
  const plain: string[] = [];
  collectBodies(payload, "text/plain", plain);
  if (plain.length) return plain.join("\n");
  const html: string[] = [];
  collectBodies(payload, "text/html", html);
  return htmlToText(html.join("\n"));
}

function header(payload: GmailPart | undefined, name: string) {
  return payload?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function stripQuotedContentAndSignature(input: string) {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  const quoteMarkers = [
    /^On .+wrote:\s*$/im,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^From:\s.+\nSent:\s.+\nTo:\s/im,
    /^_{5,}$/m,
  ];
  let cutAt = normalized.length;
  for (const marker of quoteMarkers) {
    const match = marker.exec(normalized);
    if (match?.index !== undefined) cutAt = Math.min(cutAt, match.index);
  }

  return normalized
    .slice(0, cutAt)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/\n--\s*\n[\s\S]*$/m, "")
    .replace(/\n(?:Sent from my (?:iPhone|iPad|Android)|Get Outlook for \w+)[\s\S]*$/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_EMAIL_CHARS);
}

export async function fetchSentEmailSamples(accessToken: string, expectedEmail: string) {
  const profile = await gmailFetch<{ emailAddress: string }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    accessToken,
  );
  if (profile.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new Error(`Gmail permission was granted for ${profile.emailAddress}, not ${expectedEmail}.`);
  }

  const messages: GmailMessage[] = [];
  let pageToken: string | undefined;

  do {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", "in:sent");
    listUrl.searchParams.set(
      "maxResults",
      String(Math.min(GMAIL_LIST_PAGE_SIZE, MAX_SENT_EMAILS - messages.length)),
    );
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const list = await gmailFetch<MessageList>(listUrl.toString(), accessToken);
    const ids = list.messages ?? [];
    const pageMessages = new Array<GmailMessage>(ids.length);
    let nextIndex = 0;
    async function fetchWorker() {
      while (nextIndex < ids.length) {
        const index = nextIndex++;
        const { id } = ids[index];
        pageMessages[index] = await gmailFetch<GmailMessage>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
          accessToken,
        );
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(GMAIL_FETCH_CONCURRENCY, ids.length) }, () => fetchWorker()),
    );

    messages.push(...pageMessages.filter((message) => {
      const body = stripQuotedContentAndSignature(getMessageBody(message.payload));
      return body.length >= 10;
    }));
    pageToken = list.nextPageToken;
  } while (messages.length < MAX_SENT_EMAILS && pageToken);

  const samples = messages
    .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0))
    .map((message) => ({
      recipient: header(message.payload, "To"),
      body: stripQuotedContentAndSignature(getMessageBody(message.payload)),
    }))
    .filter((sample) => sample.body.length >= 10)
    .slice(0, MAX_SENT_EMAILS);

  let remainingChars = MAX_COMBINED_CHARS;
  return samples.map((sample, index) => {
    // Reserve an equal share for every remaining email. Short early messages leave
    // their unused space available to later ones, but no later sample is dropped.
    const remainingSamples = samples.length - index;
    const bodyBudget = Math.floor(remainingChars / remainingSamples);
    const body = sample.body.slice(0, bodyBudget);
    remainingChars -= body.length;
    return { ...sample, body };
  });
}

export function buildVoiceProfilePrompt(samples: EmailSample[]) {
  const emailBlock = samples
    .slice(0, MAX_SENT_EMAILS)
    .map((sample, index) => [
      `EMAIL ${index + 1}`,
      `Recipient: ${sample.recipient || "Unknown"}`,
      "Body:",
      sample.body,
    ].join("\n"))
    .join("\n\n---\n\n");

  return `Analyze the writing style across all email samples below. Every numbered email is represented; longer bodies may be truncated to fit the input budget. Return ONLY one valid JSON object, with no prose and no markdown fences, using exactly this structure:\n\n{\n  "tone": "",\n  "greetings": [],\n  "signoffs": [],\n  "sentence_structure": "",\n  "punctuation_habits": "",\n  "common_phrases": [],\n  "formality_by_relationship": "",\n  "typical_length": "",\n  "response_pattern": ""\n}\n\nInfer relationship/formality shifts only when recipient signals support them. Keep every string compact and actionable for future email drafting.\n\n${emailBlock}`;
}
