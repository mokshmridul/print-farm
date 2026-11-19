import type { Metadata } from "next";
import { SetupWizard } from "@/components/admin/setup-wizard";
import { requireAdminPage } from "@/lib/admin-page";
import { advancedProfilesEnabled } from "@/lib/printer";
import { getStoredSiteProfile } from "@/lib/site-profile";
import { getSlicerProfilesState } from "@/lib/slicer-profiles";

export const metadata: Metadata = { title: "Set up your shop · Admin", robots: { index: false, follow: false } };

export const dynamic = "force-dynamic";

/** The guided setup: the owner's OrcaSlicer presets, a step at a time, then the
 *  shop's details. Outside the dashboard layout, which sends a new shop here. */
export default async function SetupPage() {
  await requireAdminPage();
  const [state, profile] = await Promise.all([getSlicerProfilesState(), getStoredSiteProfile().catch(() => null)]);
  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <p className="eyebrow">Admin · setup</p>
      <SetupWizard initial={state} advanced={advancedProfilesEnabled()} profile={profile} />
    </div>
  );
}
