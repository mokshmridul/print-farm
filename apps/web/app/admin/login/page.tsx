import type { Metadata } from "next";
import { ClaimForm } from "@/components/admin/claim-form";
import { AdminLogin } from "@/components/admin/login-form";
import { MIN_ADMIN_PASSWORD, adminSetupOpen } from "@/lib/admin-auth";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };

export const dynamic = "force-dynamic";

/** Sign in — or, on a new shop with no admin password yet, create it. */
export default async function AdminLoginPage() {
  if (await adminSetupOpen().catch(() => false)) return <ClaimForm minLength={MIN_ADMIN_PASSWORD} />;
  return <AdminLogin />;
}
