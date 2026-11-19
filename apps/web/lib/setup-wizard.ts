import { prisma } from "@print/db";

/**
 * The guided setup (admin → /admin/setup): a short first-run tour that has the
 * owner upload their OrcaSlicer printer, process and filament presets (each
 * through the same test-sliced upload as the Slicer profiles section), then
 * enter the shop's details. Offered once, on the first admin visit of a new
 * shop — one that has never taken a quotation — and always reachable from
 * Slicer profiles.
 */

const KEY = "setupWizard";

export async function setupWizardDone(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { key: true } });
  return row !== null;
}

/** Whether the dashboard should open the guided setup instead. */
export async function shouldOfferSetup(): Promise<boolean> {
  if (await setupWizardDone()) return false;
  // A shop already in business has set itself up some other way.
  return (await prisma.quotation.findFirst({ select: { id: true } })) === null;
}

export async function markSetupDone(): Promise<void> {
  const value = { doneAt: new Date().toISOString() };
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}
