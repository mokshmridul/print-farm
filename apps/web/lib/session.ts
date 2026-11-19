import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import {
  ADMIN_AUDIENCE,
  QUOTE_AUDIENCE,
  TOKEN_ISSUER,
  adminCookieName as sharedAdminCookieName,
  isSecureRequest,
  quoteCookieName as sharedQuoteCookieName,
} from "@print/shared";
import { env } from "./env";

/**
 * Two signed, httpOnly cookies:
 *  - "qsid": anonymous quote session (48 h) — owns uploaded models until checkout.
 *  - "admin": admin dashboard session (12 h).
 * Both are HS256 JWTs signed with SESSION_SECRET; nothing sensitive is stored
 * client-side beyond the identifier/role.
 */

const QUOTE_TTL_SECONDS = 48 * 3600;
const ADMIN_TTL_SECONDS = 12 * 3600;

const secretKey = () => new TextEncoder().encode(env.sessionSecret);

// Mark cookies Secure only when this request came over HTTPS: APP_ORIGIN is
// https and nginx didn't mark it a direct LAN visit (see isSecureRequest). The
// same shop then works through its HTTPS tunnel and at a LAN address over
// plain HTTP, each with its own cookie names, so neither shadows the other.
async function secureCookies(): Promise<boolean> {
  return isSecureRequest(env.appOrigin, (await headers()).get("x-direct-visit"));
}

async function quoteCookieName(): Promise<string> {
  return sharedQuoteCookieName(await secureCookies());
}

async function adminCookieName(): Promise<string> {
  return sharedAdminCookieName(await secureCookies());
}

async function cookieBase() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: await secureCookies(),
    path: "/",
    priority: "high" as const,
  };
}

async function sign(
  payload: Record<string, unknown>,
  ttlSeconds: number,
  audience: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(secretKey());
}

async function verify<T>(token: string | undefined, audience: string): Promise<T | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience,
    });
    return payload as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Quote session
// ---------------------------------------------------------------------------

export async function getQuoteSessionId(): Promise<string | null> {
  const store = await cookies();
  const payload = await verify<{ sid?: string }>(store.get(await quoteCookieName())?.value, QUOTE_AUDIENCE);
  return payload?.sid ?? null;
}

/** Returns the existing session id or creates one, setting the cookie.
 *  Call only from route handlers (cookie mutation). */
export async function getOrCreateQuoteSessionId(): Promise<string> {
  const existing = await getQuoteSessionId();
  if (existing) return existing;
  const sid = crypto.randomUUID();
  const token = await sign({ sid }, QUOTE_TTL_SECONDS, QUOTE_AUDIENCE);
  const store = await cookies();
  store.set(await quoteCookieName(), token, { ...(await cookieBase()), maxAge: QUOTE_TTL_SECONDS });
  return sid;
}

// ---------------------------------------------------------------------------
// Admin session
// ---------------------------------------------------------------------------

export async function isAdmin(): Promise<boolean> {
  const store = await cookies();
  const payload = await verify<{ role?: string }>(store.get(await adminCookieName())?.value, ADMIN_AUDIENCE);
  return payload?.role === "admin";
}

export async function createAdminSession(): Promise<void> {
  const token = await sign({ role: "admin" }, ADMIN_TTL_SECONDS, ADMIN_AUDIENCE);
  const store = await cookies();
  store.set(await adminCookieName(), token, { ...(await cookieBase()), maxAge: ADMIN_TTL_SECONDS });
}

export async function destroyAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(await adminCookieName());
}

/** For edge-proxy use (no next/headers cookies() there). */
export async function verifyAdminToken(token: string | undefined): Promise<boolean> {
  const payload = await verify<{ role?: string }>(token, ADMIN_AUDIENCE);
  return payload?.role === "admin";
}
