import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { isSecureRequest } from "@print/shared";
import type { NextResponse } from "next/server";
import { env } from "./env";

const HASH_PREFIX = "sha256:";
export const QUOTATION_ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const VERIFIER_RE = /^sha256:[0-9a-f]{64}$/;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

export function issueQuotationAccess(now = new Date()): {
  token: string;
  verifier: string;
  expiresAt: Date;
} {
  const token = randomBytes(32).toString("hex");
  return {
    token,
    verifier: `${HASH_PREFIX}${digest(token)}`,
    expiresAt: new Date(now.getTime() + QUOTATION_ACCESS_TTL_SECONDS * 1000),
  };
}

/** Constant-work verifier. Rows store only sha256:<digest>, so a DB/backup
 * leak does not disclose the customer bearer capability. */
export function quotationAccessMatches(
  presented: string,
  storedVerifier: string,
  expiresAt: Date,
  now = new Date(),
): boolean {
  const syntacticallyValid = TOKEN_RE.test(presented);
  const boundedToken = syntacticallyValid ? presented : "0".repeat(64);
  const storedValid = VERIFIER_RE.test(storedVerifier);
  const boundedVerifier = storedValid ? storedVerifier : `${HASH_PREFIX}${"0".repeat(64)}`;
  const candidate = `${HASH_PREFIX}${digest(boundedToken)}`;
  const equal = constantEqual(candidate, boundedVerifier);
  return syntacticallyValid && storedValid && expiresAt.getTime() > now.getTime() && equal;
}

/** HTTPS-ness of a request (see isSecureRequest): the cookie is Secure and
 * __Host- prefixed only on an HTTPS visit. */
function secureFor(requestHeaders: Headers): boolean {
  return isSecureRequest(env.appOrigin, requestHeaders.get("x-direct-visit"));
}

function cookieName(number: string, secure: boolean): string {
  const safeNumber = number.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${secure ? "__Host-" : ""}quotation_${safeNumber}`;
}

function cookieOptions(expiresAt: Date, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure,
    path: "/",
    expires: expiresAt,
    priority: "high" as const,
  };
}

export function setQuotationAccessCookie(
  request: Request,
  response: NextResponse,
  number: string,
  token: string,
  expiresAt: Date,
): void {
  const secure = secureFor(request.headers);
  response.cookies.set(cookieName(number, secure), token, cookieOptions(expiresAt, secure));
}

export async function getQuotationAccessCookie(number: string): Promise<string> {
  return (await cookies()).get(cookieName(number, secureFor(await headers())))?.value ?? "";
}
