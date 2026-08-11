import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");

function accountKey(email: string) {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export function accountDataDir(email: string) {
  return path.join(DATA_DIR, "accounts", accountKey(email));
}

export function accountFilePath(email: string, filename: string) {
  return path.join(accountDataDir(email), filename);
}

export function accountLockPath(email: string, filename: string) {
  return accountFilePath(email, filename);
}

export function legacyFilePath(filename: string) {
  return path.join(DATA_DIR, filename);
}

export async function ensureAccountDataDirectory(email: string) {
  await mkdir(accountDataDir(email), { recursive: true });
}

export async function readJsonFile<T>(filename: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filename, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeAccountJson(email: string, filename: string, value: unknown) {
  await ensureAccountDataDirectory(email);
  await writeFile(accountFilePath(email, filename), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readOwnedAccountJson<T extends { owner_email: string }>(
  email: string,
  filename: string,
): Promise<T | null> {
  const current = await readJsonFile<T>(accountFilePath(email, filename));
  if (current) return current.owner_email.toLowerCase() === email.toLowerCase() ? current : null;

  const legacy = await readJsonFile<T>(legacyFilePath(filename));
  if (!legacy || legacy.owner_email.toLowerCase() !== email.toLowerCase()) return null;
  await writeAccountJson(email, filename, legacy);
  return legacy;
}
