import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureDataDirectory, DATA_DIR } from "./voice-profile";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CALL_LOG_PATH = path.join(DATA_DIR, "openrouter_calls.jsonl");

export type OpenRouterPurpose =
  | "voice_profile"
  | "voice_examples"
  | "goals_profile"
  | "inbox_triage"
  | "importance_instruction"
  | "draft"
  | "inbox_primary_draft"
  | "inbox_alternatives"
  | "inbox_guided_reply";

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
};

type OpenRouterResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: Usage;
  error?: { message?: string };
};

export type CallLogEntry = {
  timestamp: string;
  model: string;
  purpose: OpenRouterPurpose;
  request_id: string;
  attempt: number;
  status: "success" | "error";
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number | null;
  error?: string;
};

async function logCall(entry: CallLogEntry) {
  await ensureDataDirectory();
  const line = JSON.stringify(entry);
  await appendFile(CALL_LOG_PATH, `${line}\n`, "utf8");
  console.log(`[OpenRouter] ${line}`);
}

export async function getUsageSummary() {
  let entries: CallLogEntry[] = [];
  try {
    entries = (await readFile(CALL_LOG_PATH, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CallLogEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return entries.reduce(
    (summary, entry) => ({
      total_calls: summary.total_calls + 1,
      prompt_tokens: summary.prompt_tokens + entry.prompt_tokens,
      completion_tokens: summary.completion_tokens + entry.completion_tokens,
      total_tokens: summary.total_tokens + entry.total_tokens,
      total_cost: summary.total_cost + (entry.cost ?? 0),
    }),
    { total_calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, total_cost: 0 },
  );
}

export async function callOpenRouterOnce(options: {
  model: string;
  purpose: OpenRouterPurpose;
  requestId: string;
  attempt: number;
  messages: Array<{ role: "system" | "user"; content: string }>;
  maxTokens: number;
  jsonOnly?: boolean;
}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured. No model call was made.");

  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://seasonal-diff-amber-harvey.trycloudflare.com",
        "X-Title": "Iris Inbox Agent",
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        temperature: 0.2,
        max_tokens: options.maxTokens,
        ...(options.jsonOnly ? { response_format: { type: "json_object" } } : {}),
        provider: { allow_fallbacks: false },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    await logCall({
      timestamp: new Date().toISOString(), model: options.model, purpose: options.purpose,
      request_id: options.requestId, attempt: options.attempt, status: "error",
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: null,
      error: error instanceof Error ? error.message : "Network error",
    });
    throw error;
  }

  const body = (await response.json().catch(() => ({}))) as OpenRouterResponse;
  const usage = body.usage ?? {};
  const entry: CallLogEntry = {
    timestamp: new Date().toISOString(),
    model: body.model ?? options.model,
    purpose: options.purpose,
    request_id: options.requestId,
    attempt: options.attempt,
    status: response.ok ? "success" : "error",
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    cost: typeof usage.cost === "number" ? usage.cost : null,
    ...(!response.ok ? { error: body.error?.message ?? `HTTP ${response.status}` } : {}),
  };
  await logCall(entry);
  if (!response.ok) throw new Error(entry.error);

  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("OpenRouter returned no text content.");
  return { content, usage: entry };
}
