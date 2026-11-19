import { NextResponse, type NextRequest } from "next/server";
import { guardMutation, jsonError, readJsonBody } from "@/lib/api-util";
import { AdminAlreadyClaimed, MIN_ADMIN_PASSWORD, adminSetupOpen, claimAdminPassword, setupCodeMatches } from "@/lib/admin-auth";
import { RATE_LIMITS, reserveRateLimit } from "@/lib/security";
import { createAdminSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

/** First run: create the admin password with the one-time setup code from the
 *  container log, and sign in. Refused once a password exists. */
export async function POST(request: NextRequest) {
  const guard = await guardMutation(request, "adminLogin", RATE_LIMITS.adminLogin);
  if (guard) return guard;
  if (!(await adminSetupOpen())) return jsonError(409, "ALREADY_SET_UP", "This shop already has an admin password. Sign in instead.");

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const { code, password } = (body.value ?? {}) as { code?: unknown; password?: unknown };
  if (typeof code !== "string" || typeof password !== "string") {
    return jsonError(422, "BAD_REQUEST", "Enter the setup code and a password.");
  }
  const bytes = Buffer.byteLength(password, "utf8");
  if (password.length < MIN_ADMIN_PASSWORD || bytes > 72) {
    return jsonError(422, "WEAK_PASSWORD", `Use ${MIN_ADMIN_PASSWORD}–72 characters for the admin password.`);
  }
  // One budget for every guess at the code, whatever address it comes from.
  const global = await reserveRateLimit(
    "adminLoginGlobal",
    "all",
    RATE_LIMITS.adminLoginGlobal.max,
    RATE_LIMITS.adminLoginGlobal.windowSeconds,
  );
  if (!global.allowed) return jsonError(429, "RATE_LIMITED", "Too many attempts — please wait a little.");
  if (!setupCodeMatches(code)) {
    return jsonError(401, "INVALID_SETUP_CODE", "That setup code isn't right. It's in the container's log: docker logs <container>.");
  }
  try {
    await claimAdminPassword(password);
  } catch (error) {
    if (error instanceof AdminAlreadyClaimed) {
      return jsonError(409, "ALREADY_SET_UP", "This shop already has an admin password. Sign in instead.");
    }
    throw error;
  }
  await createAdminSession();
  return NextResponse.json({ ok: true });
}
