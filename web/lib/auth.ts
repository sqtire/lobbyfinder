import crypto from "crypto";
import { cookies } from "next/headers";

const COOKIE = "mpf_session";
const MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}
function hmac(data: string): string {
  return crypto.createHmac("sha256", secret()).update(data).digest("base64url");
}

/** token = base64url(json).hmac  where json = { exp }. */
export function createSessionToken(): string {
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + MAX_AGE_S });
  const body = b64url(payload);
  return `${body}.${hmac(body)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  // constant-time signature comparison
  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, "base64url").toString()) as { exp: number };
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/** Verify a plaintext password attempt against APP_PASSWORD (constant-time). */
export function checkPassword(attempt: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) throw new Error("APP_PASSWORD is not set");
  const a = Buffer.from(attempt);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const cookieName = COOKIE;
export const cookieMaxAge = MAX_AGE_S;

/** Read auth state in a server component / route handler. */
export function isAuthed(): boolean {
  const token = cookies().get(COOKIE)?.value;
  return verifySessionToken(token);
}
