/**
 * Minimal single-password auth using a signed (HMAC) session cookie.
 *
 * - No database: the cookie itself is the session, signed with AUTH_SECRET.
 * - Uses Web Crypto (crypto.subtle) so it works in both the Edge runtime
 *   (proxy.ts) and the Node runtime (API routes).
 * - Cookie value format: `<expiryMs>.<base64url-hmac>`.
 */

export const SESSION_COOKIE = "app_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24; // 24 hours

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  return secret;
}

/** Constant-time-ish password check. */
export function isPasswordValid(input: string): boolean {
  const expected = process.env.APP_PASSWORD ?? "";
  if (!expected) return false;
  if (input.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= input.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function toBase64Url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toBase64Url(sig);
}

/** Create a signed session token valid for SESSION_MAX_AGE_SECONDS. */
export async function createSessionToken(): Promise<string> {
  const expiry = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = String(expiry);
  const sig = await hmac(payload);
  return `${payload}.${sig}`;
}

/** Verify a session token: valid signature and not expired. */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await hmac(payload);
  if (sig !== expected) return false;

  const expiry = Number(payload);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  return true;
}
