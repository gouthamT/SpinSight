import { NextResponse } from "next/server";
import { timingSafeEqual, createHash } from "node:crypto";
import { authConfig, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth/config";
import { createSessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";

function safeEqual(a: string, b: string): boolean {
  // Hash first so lengths match and comparison time is constant.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(req: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const cfg = authConfig();
  const ok = safeEqual(username, cfg.username) && safeEqual(password, cfg.password);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }
  const token = await createSessionToken(username);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
