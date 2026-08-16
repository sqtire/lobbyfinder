import { NextResponse } from "next/server";
import { tenantAccess } from "./auth";
import type { Tenant, TenantAccess } from "./types";

export const json = (body: unknown, init?: ResponseInit) =>
  NextResponse.json(body, { ...init, headers: { "cache-control": "no-store", ...(init?.headers ?? {}) } });
export const bad = (error: string, status = 400) => json({ error }, { status });

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** Resolve tenant + access; returns a ready-made error response when the check fails. */
export async function requireTenant(
  slug: string,
  level: "public" | "edit" | "manage"
): Promise<{ ok: true; tenant: Tenant; access: TenantAccess } | { ok: false; res: NextResponse }> {
  const { tenant, access } = await tenantAccess(slug);
  if (!tenant) return { ok: false, res: bad("tournament not found", 404) };
  if (level === "edit" && !access.can_edit) return { ok: false, res: bad(access.user ? "forbidden" : "sign in required", access.user ? 403 : 401) };
  if (level === "manage" && !access.can_manage) return { ok: false, res: bad(access.user ? "forbidden" : "sign in required", access.user ? 403 : 401) };
  return { ok: true, tenant, access };
}
