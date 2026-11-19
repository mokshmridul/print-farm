import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AdminNav } from "@/components/admin/admin-nav";
import { requireAdminPage } from "@/lib/admin-page";
import { shopSetupGaps } from "@/lib/printer";
import { shouldOfferSetup } from "@/lib/setup-wizard";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Every admin section: the nav, then the section's page. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminPage();
  // A new advanced-mode shop starts with the guided setup of its presets.
  if (await shouldOfferSetup()) redirect("/admin/setup");
  const gaps = await shopSetupGaps();
  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <p className="eyebrow">Admin</p>
      <div className="mt-3">
        <AdminNav />
      </div>
      {gaps.printer || gaps.material ? (
        <p role="status" className="tile mt-6 p-4 text-sm">
          <span className="font-[650] text-accent">Not taking quotes yet.</span>{" "}
          {gaps.printer
            ? "No printer is set up: upload your OrcaSlicer printer preset in the "
            : "No material is on sale: upload an OrcaSlicer filament preset for one (none are built in) in the "}
          <a href="/admin/setup" className="underline">
            guided setup
          </a>{" "}
          or put it in the profiles folder
          {gaps.printer ? ", or pick a printer by re-running the installer." : ", then switch the material on under Filament."}
        </p>
      ) : null}
      {children}
    </div>
  );
}
