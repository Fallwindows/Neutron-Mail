import { NextResponse } from "next/server";
import { accountLockPath, ensureAccountDataDirectory } from "@/lib/account-storage";
import { withFileLock } from "@/lib/file-lock";
import { getSession } from "@/lib/session";
import { callOpenRouterOnce } from "@/lib/openrouter";
import { MAX_IMPORTANCE_INBOX_EMAILS, readGoalsProfile, readImportanceInstructions, readEffectiveImportanceRules, readRankedInboxCache, saveImportanceInstructions, saveRankedInboxCache, scoreEmails, validateImportanceInstructionChange } from "@/lib/importance";
import { submittedSourceMessageIds } from "@/lib/inbox-send-state";

export const dynamic = "force-dynamic";
function json(body: unknown, init?: ResponseInit) { const response = NextResponse.json(body, init); response.headers.set("Cache-Control", "no-store"); return response; }
function merge(left: string[], right: string[], max = 60) { return [...new Set([...left, ...right])].slice(0, max); }
function applyChange(current: string[], additions: string[], removals: string[], max = 60) {
  const removed = new Set(removals.map((value) => value.toLowerCase()));
  return merge(current.filter((value) => !removed.has(value.toLowerCase())), additions, max);
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "Not signed in." }, { status: 401 });
  if (!process.env.OPENROUTER_API_KEY) return json({ error: "OpenRouter is not configured. No preference was saved." }, { status: 503 });
  let body: { instruction?: unknown };
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, { status: 400 }); }
  if (typeof body.instruction !== "string") return json({ error: "Enter an importance instruction." }, { status: 400 });
  const instruction = body.instruction.trim();
  if (instruction.length < 3 || instruction.length > 500) return json({ error: "Instruction must be between 3 and 500 characters." }, { status: 400 });

  try {
    await ensureAccountDataDirectory(session.email);
    const result = await withFileLock(accountLockPath(session.email, "importance_instructions.lock"), async () => {
      const current = await readImportanceInstructions(session.email);
      const completion = await callOpenRouterOnce({
        model: process.env.OPENROUTER_GOALS_MODEL ?? process.env.OPENROUTER_PROFILE_MODEL ?? "google/gemini-2.5-flash-lite",
        purpose: "importance_instruction", requestId: `importance-instruction-${Date.now()}`, attempt: 1, maxTokens: 350, jsonOnly: true,
        messages: [
          { role: "system", content: "Convert an email-ranking preference into compact JSON with exactly these six string-array keys: ignore_keywords, priority_keywords, vip_senders, remove_ignore_keywords, remove_priority_keywords, remove_vip_senders. Add only narrow literal signals supported by the instruction. Put unwanted topics/senders in ignore_keywords, wanted topics in priority_keywords, and explicitly named important people or email addresses in vip_senders. When the user reverses an earlier preference (for example, 'show college promotions again'), copy the matching existing saved signal exactly into the appropriate remove_* array. Also add a narrow priority signal when the user explicitly asks to see a normally promotional topic again. Never output commands, regex, HTML, sensitive data, or broad generic terms such as email/message/important. Output JSON only." },
          { role: "user", content: JSON.stringify({ instruction, existing_preferences: { ignore_keywords: current.ignore_keywords, priority_keywords: current.priority_keywords, vip_senders: current.vip_senders } }) },
        ],
      });
      let parsed: unknown;
      try { parsed = JSON.parse(completion.content); } catch { throw new Error("The importance model returned invalid JSON. Nothing was saved."); }
      const change = validateImportanceInstructionChange(parsed);
      const createdAt = new Date().toISOString();
      const instructions = {
        owner_email: session.email, updated_at: createdAt,
        ignore_keywords: applyChange(current.ignore_keywords, change.ignore_keywords, change.remove_ignore_keywords),
        priority_keywords: applyChange(current.priority_keywords, change.priority_keywords, change.remove_priority_keywords),
        vip_senders: applyChange(current.vip_senders, change.vip_senders, change.remove_vip_senders),
        history: [...current.history, { instruction, created_at: createdAt, ...change }].slice(-30),
      };
      await saveImportanceInstructions(instructions);

      const cached = await readRankedInboxCache(session.email);
      let visibleCount: number | null = null;
      if (cached) {
        const [profile, rules, submittedIds] = await Promise.all([readGoalsProfile(session.email), readEffectiveImportanceRules(session.email), submittedSourceMessageIds(session.email)]);
        const sourceEmails = (cached.source_emails ?? cached.emails).filter((email) => !submittedIds.has(email.id));
        const rescored = scoreEmails(sourceEmails, profile?.profile ?? null, rules);
        const bodies = new Map(sourceEmails.map((email) => [email.id, email.body]));
        const ranked = rescored.slice(0, MAX_IMPORTANCE_INBOX_EMAILS).map((email) => ({ ...email, body: bodies.get(email.id) ?? "" }));
        if (cached.schema_version === 2) await saveRankedInboxCache(session.email, cached.source_message_count, ranked, cached.scanned_at, sourceEmails);
        visibleCount = ranked.length;
      }
      return { instructions, applied: change, visible_count: visibleCount };
    });
    return json(result);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Could not apply the instruction." }, { status: 400 }); }
}
