import { NextResponse } from "next/server";
import { OAUTH_COOKIE, exchangeCodeForUser, issueSession, publicBaseUrl, verify } from "@/lib/auth";
import { upsertUser } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(reason: string) {
  const u = new URL("/", publicBaseUrl());
  u.searchParams.set("login_error", reason);
  return NextResponse.redirect(u.toString());
}

/** osu! sends the user back here with ?code=&state=. Exchange, identify, start a session. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieHeader = req.headers.get("cookie") ?? "";
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${OAUTH_COOKIE}=`))
    ?.slice(OAUTH_COOKIE.length + 1);
  const pending = verify<{ state: string; next: string; exp: number }>(raw ? decodeURIComponent(raw) : undefined);

  if (!code || !state) return fail(url.searchParams.get("error") === "access_denied" ? "cancelled" : "missing_code");
  if (!pending || pending.state !== state || pending.exp < Math.floor(Date.now() / 1000)) return fail("bad_state");

  let me;
  try {
    me = await exchangeCodeForUser(code);
  } catch (e) {
    console.error("[auth] callback failed:", (e as Error).message);
    return fail("exchange_failed");
  }
  await upsertUser({ osu_id: me.id, username: me.username, avatar_url: me.avatar_url, country_code: me.country_code });
  const cookie = await issueSession(me.id);

  const dest = pending.next && pending.next.startsWith("/") && !pending.next.startsWith("//") ? pending.next : "/";
  const res = NextResponse.redirect(new URL(dest, publicBaseUrl()).toString());
  res.cookies.set(cookie.name, cookie.value, cookie.options as never);
  res.cookies.set(OAUTH_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
