/**
 * Session token and cookie naming, shared between lib/session.ts (issuing and
 * verifying via next/headers) and proxy.ts (edge-compatible re-verifier).
 * The proxy keeps its own verification logic; only these constants are
 * shared so the two cannot drift apart.
 */

export const TOKEN_ISSUER = "print-farm";
export const QUOTE_AUDIENCE = "quote-session";
export const ADMIN_AUDIENCE = "admin-session";

/** Cookies carry the __Host- prefix only when served over HTTPS; plain-HTTP
 * access (e.g. a LAN IP while testing) cannot satisfy the prefix rules. */
export function quoteCookieName(secure: boolean): string {
  return secure ? "__Host-qsid" : "qsid";
}

export function adminCookieName(secure: boolean): string {
  return secure ? "__Host-admin_session" : "admin_session";
}

/** Whether this request reached the shop over HTTPS, so its cookies can be
 * Secure and __Host- prefixed and HTTPS-only headers apply.
 *
 * APP_ORIGIN decides, with one exception: the image's nginx sets
 * X-Direct-Visit: 1 on a visit straight from a LAN device beside the trusted
 * forwarder (served only with DIRECT_ACCESS=1), which is plain HTTP. nginx is
 * the only way in and always overwrites that header, so it can't be forged; a
 * request without it keeps APP_ORIGIN's scheme. */
export function isSecureRequest(
  appOrigin: string | undefined,
  directVisit: string | null | undefined,
): boolean {
  if (!appOrigin?.startsWith("https://")) return false;
  return directVisit?.trim() !== "1";
}
