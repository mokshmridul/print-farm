import { NextResponse, type NextRequest } from "next/server";
import { jsonError, readJsonBody, requireAdminApi } from "@/lib/api-util";
import { assertSameOrigin } from "@/lib/security";
import { ServerSettingsRejected, saveServerSettings, serverSettingsView } from "@/lib/server-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

/** Admin: the server settings (web address, reverse proxy, printer). */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json(serverSettingsView());
}

/** Admin: change some of them. The container applies a save within seconds,
 *  restarting web and worker — the response says so. */
export async function PUT(request: NextRequest) {
  const auth = await requireAdminApi();
  if (auth) return auth;
  if (!assertSameOrigin(request)) return jsonError(403, "CSRF", "Cross-origin request rejected");
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const value = (body.value ?? {}) as Record<string, unknown>;
  try {
    const settings = await saveServerSettings({ siteAddress: value.siteAddress, proxy: value.proxy, printer: value.printer });
    return NextResponse.json({ ...serverSettingsView(), settings, restarting: true });
  } catch (error) {
    if (error instanceof ServerSettingsRejected) return jsonError(422, "INVALID_SETTINGS", error.message);
    throw error;
  }
}
