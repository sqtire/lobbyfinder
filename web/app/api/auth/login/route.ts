import { NextResponse } from "next/server";
import crypto from "crypto";
import { OAUTH_COOKIE, authorizeUrl, sign } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start the osu! login: remember a CSRF state (+ where to return) and bounce to osu!. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  let next = url.searchParams.get("next") ?? "/";
  if (!next.startsWith("/") || next.startsWith("//")) next = "/"; // same-origin paths only
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authorizeUrl(state));
  res.cookies.set(OAUTH_COOKIE, sign({ state, next, exp: Math.floor(Date.now() / 1000) + 600 }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
