import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";
// Subpath import keeps the edge bundle free of the full shared barrel (zod etc.).
import {
  ADMIN_AUDIENCE,
  TOKEN_ISSUER,
  adminCookieName,
  isSecureRequest,
} from "@print/shared/session-constants";

/** Edge proxy (`middleware.ts` before Next 16): applies the
 *  Content-Security-Policy + security headers to every response, and gates the
 *  admin area. Keeps its own verification logic (no next/headers import) so it
 *  stays edge-compatible; it re-verifies the same HS256 admin cookie that
 *  lib/session.ts issues, sharing only the token and cookie-name constants. */

async function isAdminToken(token: string | undefined): Promise<boolean> {
  if (!token || !process.env.SESSION_SECRET) return false;
  try {
    const secret = new TextEncoder().encode(process.env.SESSION_SECRET);
    if (secret.byteLength < 32) return false;
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: ADMIN_AUDIENCE,
    });
    return (payload as { role?: string }).role === "admin";
  } catch {
    return false;
  }
}

function contentSecurityPolicy(nonce: string, secure: boolean): string {
  // Google Maps (optional) is the only permitted external frame.
  const mapsConfigured = !!process.env.GOOGLE_MAPS_EMBED_URL;
  const frameSrc = mapsConfigured ? "https://www.google.com" : "'none'";
  return [
    "default-src 'self'",
    // blob: for the Three.js WebGL viewer + thumbnails; data: for inline icons.
    "img-src 'self' blob: data:",
    "worker-src 'self' blob:",
    // Next.js injects an inline bootstrap + the theme-init script; Tailwind
    // emits a static stylesheet but Next also inlines critical CSS.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
    }`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frameSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    // Only on an HTTPS visit: on a plain-HTTP LAN visit it would send every
    // asset to https:// on an address that doesn't serve it.
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

function withSecurityHeaders(
  response: NextResponse,
  nonce: string,
  pathname: string,
  secure: boolean,
): NextResponse {
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce, secure));
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Browsers ignore COOP on a plain-http origin other than localhost (the
  // installer's home-network test mode, or a LAN visit to an HTTPS shop) and
  // log an error on every page for it.
  const appOrigin = process.env.APP_ORIGIN ?? "";
  const coop = appOrigin.startsWith("https://")
    ? secure
    : !/^http:\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$)/.test(appOrigin);
  if (coop) {
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  }
  if (secure) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (
    pathname.startsWith("/admin") ||
    pathname.startsWith("/api/admin") ||
    pathname.startsWith("/quotation/") ||
    pathname.startsWith("/api/quotations/")
  ) {
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const secure = isSecureRequest(process.env.APP_ORIGIN, request.headers.get("x-direct-visit"));

  // --- admin gate ---
  const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  // The first-run claim (create the admin password with the setup code) is
  // reached before there is any admin to be.
  const isLogin = pathname === "/admin/login" || pathname === "/api/admin/login" || pathname === "/api/admin/claim";

  if (isAdminPath && !isLogin) {
    const authed = await isAdminToken(
      request.cookies.get(adminCookieName(secure))?.value,
    );
    if (!authed) {
      if (pathname.startsWith("/api/admin")) {
        return withSecurityHeaders(
          NextResponse.json(
            { error: { code: "UNAUTHENTICATED", message: "Admin login required" } },
            { status: 401 },
          ),
          nonce,
          pathname,
          secure,
        );
      }
      const url = request.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = pathname !== "/admin" ? `?next=${encodeURIComponent(pathname)}` : "";
      return withSecurityHeaders(NextResponse.redirect(url), nonce, pathname, secure);
    }
  }

  const requestHeaders = new Headers(request.headers);
  const csp = contentSecurityPolicy(nonce, secure);
  // Next extracts the nonce from the request CSP and applies it to framework
  // scripts. x-nonce is for the explicit theme bootstrap in the root layout.
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-nonce", nonce);
  return withSecurityHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    nonce,
    pathname,
    secure,
  );
}

export const config = {
  // Everything except Next's static assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
