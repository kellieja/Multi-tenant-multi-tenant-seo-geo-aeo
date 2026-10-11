import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not configured");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return buf;
}

/** Encrypts a JSON-serialisable value. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret<T = unknown>(payload: string): T {
  const [version, ivB64, tagB64, dataB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) throw new Error("Unrecognised secret format");
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

export const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

function hmacKey(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not configured");
  return s;
}

/** Signs a short-lived payload (e.g. OAuth state). Returns base64url(payload).sig */
export function signPayload(payload: object, ttlSeconds = 600): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  const sig = createHmac("sha256", hmacKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPayload<T extends object>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", hmacKey()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
  if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
  return parsed;
}

/** Shows only the last 4 characters of a secret for UI display. */
export const maskSecret = (s: string) => (s.length <= 4 ? "••••" : `••••${s.slice(-4)}`);
