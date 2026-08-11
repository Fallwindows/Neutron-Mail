import { createHash } from "node:crypto";
import { accountFilePath, readJsonFile, writeAccountJson } from "./account-storage";

export type DraftCacheEntry = {
  attempts: number;
  created_at?: string;
  draft?: string;
  last_error?: string;
};

export type DraftCache = Record<string, DraftCacheEntry>;

export function draftKey(ownerEmail: string, originalEmail: string, context: string) {
  return createHash("sha256")
    .update(ownerEmail).update("\0").update(originalEmail).update("\0").update(context)
    .digest("hex");
}

export async function readDraftCache(ownerEmail: string): Promise<DraftCache> {
  return (await readJsonFile<DraftCache>(accountFilePath(ownerEmail, "draft_cache.json"))) ?? {};
}

export async function saveDraftCache(ownerEmail: string, cache: DraftCache) {
  await writeAccountJson(ownerEmail, "draft_cache.json", cache);
}
