import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { markSetupDone } from "@/lib/setup-wizard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: the guided setup is finished (or skipped); stop offering it. */
export async function POST(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  await markSetupDone();
  return NextResponse.json({ ok: true });
}
