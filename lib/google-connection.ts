import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { OAuth2Client } from "google-auth-library";
import { accountFilePath, readJsonFile, writeAccountJson } from "@/lib/account-storage";

const CONNECTION_FILE = "google_connection.json";
const AAD_VERSION = "iris-google-connection-v1";

type EncryptedConnection = {
  version: 1;
  owner_email: string;
  iv: string;
  ciphertext: string;
  tag: string;
  scopes: string[];
  connected_at: string;
};

function config() {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not fully configured.");
  return { clientId, clientSecret };
}

function encryptionKey() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
  return createHash("sha256").update(`google-refresh-token\0${secret}`).digest();
}

function aad(email: string) {
  return Buffer.from(`${AAD_VERSION}\0${email.trim().toLowerCase()}`, "utf8");
}

function encryptRefreshToken(email: string, refreshToken: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(aad(email));
  const ciphertext = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

function decryptRefreshToken(record: EncryptedConnection) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(record.iv, "base64url"));
  decipher.setAAD(aad(record.owner_email));
  decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export async function saveGoogleConnection(email: string, refreshToken: string, scopes: string[]) {
  const encrypted = encryptRefreshToken(email, refreshToken);
  await writeAccountJson(email, CONNECTION_FILE, {
    version: 1,
    owner_email: email,
    ...encrypted,
    scopes,
    connected_at: new Date().toISOString(),
  } satisfies EncryptedConnection);
}

async function readConnection(email: string) {
  const record = await readJsonFile<EncryptedConnection>(accountFilePath(email, CONNECTION_FILE));
  if (!record || record.version !== 1 || record.owner_email.toLowerCase() !== email.toLowerCase()) return null;
  return record;
}

export async function hasGoogleConnection(email: string) {
  try {
    const record = await readConnection(email);
    if (!record) return false;
    decryptRefreshToken(record);
    return true;
  } catch {
    return false;
  }
}

export async function removeGoogleConnection(email: string) {
  await unlink(accountFilePath(email, CONNECTION_FILE)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function getStoredGoogleAccessToken(email: string) {
  const record = await readConnection(email);
  if (!record) throw new Error("Google is not connected. Connect Google once to continue.");
  const { clientId, clientSecret } = config();
  const oauth = new OAuth2Client(clientId, clientSecret);
  oauth.setCredentials({ refresh_token: decryptRefreshToken(record) });
  const token = await oauth.getAccessToken();
  if (!token.token) throw new Error("Google access could not be refreshed. Reconnect Google.");
  return token.token;
}

export async function resolveGoogleAccessToken(email: string, candidate: unknown) {
  if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 4096) return candidate;
  return getStoredGoogleAccessToken(email);
}

export function createGoogleOAuthClient(redirectUri: string) {
  const { clientId, clientSecret } = config();
  return new OAuth2Client(clientId, clientSecret, redirectUri);
}
