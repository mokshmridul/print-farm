import { prisma } from "@print/db";
import { advancedProfilesEnabled } from "./printer";

/**
 * The guided setup (admin → /admin/setup): the owner's OrcaSlicer printer,
 * process and filament presets, uploaded one step at a time through the same
 * test-sliced upload as the Slicer profiles section. Offered once, on the first
 * admin visit of an advanced-mode shop that has no presets of its own yet —
 * neither uploaded nor in the profiles folder — and always reachable from
 * Slicer profiles.
 */

const KEY = "setupWizard";

export async function setupWizardDone(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY }, select: { key: true } });
  return row !== null;
}

/** Whether the dashboard should open the guided setup instead. */
export async function shouldOfferSetup(): Promise<boolean> {
  if (!advancedProfilesEnabled()) return false;
  if (await setupWizardDone()) return false;
  return (await prisma.slicerProfileUpload.count()) === 0;
}

export async function markSetupDone(): Promise<void> {
  const value = { doneAt: new Date().toISOString() };
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}
