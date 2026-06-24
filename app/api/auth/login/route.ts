import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  isPasswordValid,
} from "@/lib/auth";
import { createLogger } from "@/lib/logger";

export const runtime = "nodejs";

const log = createLogger("api/auth/login");

export async function POST(req: Request): Promise<Response> {
  if (!process.env.APP_PASSWORD || !process.env.AUTH_SECRET) {
    log.error("APP_PASSWORD or AUTH_SECRET not configured");
    return NextResponse.json(
      { error: "Auth is not configured on the server." },
      { status: 500 },
    );
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = body?.password ?? "";

  if (!isPasswordValid(password)) {
    log.warn("Failed login attempt");
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const token = await createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  log.info("Successful login");
  return res;
}
