import crypto from "crypto";
import { cookies, headers } from "next/headers";
import { createSession, deleteSession, getRole, getSessionOsuId, getTenant, getUser } from "./redis";
import type { SessionUser, Tenant, TenantAccess } from "./types";

export const SESSION_COOKIE = "lf_sid";
export const OAUTH_COOKIE = "lf_oauth";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

const OSU_AUTHORIZE = "https://osu.ppy.sh/oauth/authorize";
const OSU_TOKEN = "https://osu.ppy.sh/oauth/token";
const OSU_ME = "https://osu.ppy.sh/api/v2/me";

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
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** token = base64url(json).hmac */
export function sign(payload: object): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}
export function verify<T>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEq(sig, hmac(body))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

// ---- site owner ----

export function siteOwnerIds(): Set<number> {
  return new Set(
    (process.env.OWNER_OSU_IDS ?? "")
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
}
export function isSiteOwner(osuId: number): boolean {
  return siteOwnerIds().has(osuId);
}

// ---- sessions ----

export interface SessionCookiePayload {
  sid: string;
}

/** Resolve the signed-in user from the request cookies (server components / route handlers). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = verify<SessionCookiePayload>(token);
  if (!payload?.sid) return null;
  const osuId = await getSessionOsuId(payload.sid);
  if (!osuId) return null;
  const user = await getUser(osuId);
  return {
    osu_id: osuId,
    username: user?.username ?? `user ${osuId}`,
    avatar_url: user?.avatar_url ?? null,
    is_site_owner: isSiteOwner(osuId),
  };
}

export async function issueSession(osuId: number): Promise<{ name: string; value: string; options: Record<string, unknown> }> {
  const sid = await createSession(osuId);
  return {
    name: SESSION_COOKIE,
    value: sign({ sid }),
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_S,
    },
  };
}
export async function revokeSession(): Promise<void> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const payload = verify<SessionCookiePayload>(token);
  if (payload?.sid) await deleteSession(payload.sid);
}

// ---- tenant access ----

export async function tenantAccess(slug: string): Promise<{ tenant: Tenant | null; access: TenantAccess }> {
  const [tenant, user] = await Promise.all([getTenant(slug), getSessionUser()]);
  const role = tenant && user ? await getRole(slug, user.osu_id) : null;
  const isSite = !!user?.is_site_owner;
  const isTenantOwner = !!tenant && !!user && (tenant.owner_id === user.osu_id || role === "owner");
  return {
    tenant,
    access: {
      user,
      role,
      can_edit: !!tenant && (isSite || role !== null),
      can_manage: !!tenant && (isSite || isTenantOwner),
      is_site_owner: isSite,
    },
  };
}

// ---- osu! OAuth (authorization code grant, identify scope) ----

function clientId(): string {
  const v = process.env.OSU_CLIENT_ID;
  if (!v) throw new Error("OSU_CLIENT_ID is not set");
  return v;
}
function clientSecret(): string {
  const v = process.env.OSU_CLIENT_SECRET;
  if (!v) throw new Error("OSU_CLIENT_SECRET is not set");
  return v;
}

/** Public origin for building the OAuth callback URL (PUBLIC_BASE_URL wins; else derived from proxy headers). */
export function publicBaseUrl(): string {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, "");
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
export function redirectUri(): string {
  return `${publicBaseUrl()}/api/auth/callback`;
}

export function authorizeUrl(state: string): string {
  const u = new URL(OSU_AUTHORIZE);
  u.searchParams.set("client_id", clientId());
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "identify");
  u.searchParams.set("state", state);
  return u.toString();
}

export interface OsuMe {
  id: number;
  username: string;
  avatar_url: string | null;
  country_code: string | null;
  is_restricted: boolean;
}

export async function exchangeCodeForUser(code: string): Promise<OsuMe> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  const tokenRes = await fetch(OSU_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    cache: "no-store",
  });
  if (!tokenRes.ok) throw new Error(`osu! token exchange failed (${tokenRes.status})`);
  const tok = (await tokenRes.json()) as { access_token?: string };
  if (!tok.access_token) throw new Error("osu! token exchange returned no access token");

  const meRes = await fetch(OSU_ME, {
    headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!meRes.ok) throw new Error(`osu! /me failed (${meRes.status})`);
  const me = (await meRes.json()) as { id?: number; username?: string; avatar_url?: string; country_code?: string; is_restricted?: boolean };
  if (!Number.isInteger(me.id) || typeof me.username !== "string") throw new Error("osu! /me returned an unexpected shape");
  // We never use the user's token again (all API traffic uses the worker's client credentials), so drop it here.
  return {
    id: me.id as number,
    username: me.username,
    avatar_url: typeof me.avatar_url === "string" ? me.avatar_url : null,
    country_code: typeof me.country_code === "string" ? me.country_code : null,
    is_restricted: !!me.is_restricted,
  };
}
