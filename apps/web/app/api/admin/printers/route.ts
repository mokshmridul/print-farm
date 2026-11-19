import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/api-util";
import { printerChoices } from "@/lib/server-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin: every printer OrcaSlicer ships that the shop can be set up with. */
export async function GET() {
  const auth = await requireAdminApi();
  if (auth) return auth;
  return NextResponse.json({ printers: printerChoices() });
}
