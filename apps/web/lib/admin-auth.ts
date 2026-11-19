import { timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@print/db";
import { env } from "./env";

/**
 * The admin password. ADMIN_PASSWORD(_HASH) in the container's environment
 * wins; otherwise it is the owner's own, kept in the database (AppSetting
 * "adminPassword"). A new shop has neither: the first visitor creates it,
 * proving with the one-time setup code from the container log that they
 * run the container (`docker logs`), as Sonarr-style images do on first run.
 */

const KEY = "adminPassword";
const BCRYPT = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;
export const MIN_ADMIN_PASSWORD = 12;

export async function adminPasswordHash(): Promise<string | null> {
  const fromEnv = env.adminPasswordHash;
  if (fromEnv) return fromEnv;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const hash = (row?.value as { hash?: unknown } | null)?.hash;
  return typeof hash === "string" && BCRYPT.test(hash) ? hash : null;
}

/** No admin password yet: the setup page creates one. */
export async function adminSetupOpen(): Promise<boolean> {
  return (await adminPasswordHash()) === null;
}

/** Compare the setup code without leaking how much of it matched. */
export function setupCodeMatches(given: string): boolean {
  const expected = env.setupCode;
  if (!expected) return false;
  const a = Buffer.from(given.trim().toUpperCase());
  const b = Buffer.from(expected.toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AdminAlreadyClaimed extends Error {}

/** Create the first admin password. Refuses if one exists, including one a
 *  concurrent claim created a moment ago (the row is created, never upserted). */
export async function claimAdminPassword(password: string): Promise<void> {
  if (!(await adminSetupOpen())) throw new AdminAlreadyClaimed();
  const hash = await bcrypt.hash(password, 12);
  try {
    await prisma.appSetting.create({ data: { key: KEY, value: { hash } } });
  } catch {
    throw new AdminAlreadyClaimed();
  }
}
