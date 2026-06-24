import { NextResponse } from "next/server";
import { checkPassword, createSessionToken, cookieName, cookieMaxAge } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let password = "";
  try {
    const body = (await req.json()) as { password?: string };
    password = body.password ?? "";
  } catch {
    return NextResponse.json({ ok: false, error: "invalid request" }, { status: 400 });
  }

  if (!checkPassword(password)) {
    return NextResponse.json({ ok: false, error: "wrong password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: cookieMaxAge,
  });
  return res;
}
