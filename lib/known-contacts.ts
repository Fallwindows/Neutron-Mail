import { readOwnedAccountJson, writeAccountJson } from "./account-storage";

const FILENAME = "known_contacts.json";
const MAX_CONTACTS = 2_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

type KnownContactStore = {
  owner_email: string;
  updated_at: string;
  contacts: string[];
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

export async function readKnownContacts(ownerEmail: string, allowStale = false) {
  const stored = await readOwnedAccountJson<KnownContactStore>(ownerEmail, FILENAME);
  if (!stored || (!allowStale && Date.now() - Date.parse(stored.updated_at) > MAX_AGE_MS)) return null;
  return new Set(stored.contacts.map(normalize).filter(Boolean));
}

export async function saveKnownContacts(ownerEmail: string, contacts: Iterable<string>) {
  const clean = [...new Set([...contacts].map(normalize).filter(Boolean))].slice(0, MAX_CONTACTS);
  await writeAccountJson(ownerEmail, FILENAME, {
    owner_email: ownerEmail,
    updated_at: new Date().toISOString(),
    contacts: clean,
  } satisfies KnownContactStore);
  return new Set(clean);
}
