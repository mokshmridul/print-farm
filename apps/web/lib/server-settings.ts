import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import {
  DEFAULT_SERVER_SETTINGS,
  checkSiteAddress,
  isProxyAddress,
  normalizeServerSettings,
  parsePrinterList,
  type PrinterChoice,
  type ServerSettings,
} from "@print/shared";
import { env } from "./env";

/**
 * The owner's server settings (packages/shared/src/server-settings.ts): read
 * from and saved to config/settings.json in the data folder. The container
 * notices a save and applies it — new printer profiles, nginx, a restart of
 * web and worker — within a few seconds. Settings the environment sets are
 * locked: shown, never changed here.
 */

let printers: PrinterChoice[] | null = null;

/** Every printer the shop can be set up with (built into the image). */
export function printerChoices(): PrinterChoice[] {
  if (printers) return printers;
  try {
    printers = env.printersFile ? parsePrinterList(readFileSync(env.printersFile, "utf8")) : [];
  } catch {
    printers = [];
  }
  return printers;
}

const machines = () => new Set(printerChoices().map((p) => p.machine));

export function readServerSettings(): ServerSettings {
  const file = env.serverSettingsFile;
  if (!file) return structuredClone(DEFAULT_SERVER_SETTINGS);
  try {
    return normalizeServerSettings(JSON.parse(readFileSync(file, "utf8")), machines());
  } catch {
    return structuredClone(DEFAULT_SERVER_SETTINGS);
  }
}

export interface ServerSettingsView {
  settings: ServerSettings;
  /** Which of siteAddress / proxy / printer the environment sets. */
  locked: { siteAddress: boolean; proxy: boolean; printer: boolean };
  /** Whether settings can be saved here at all (the container sets the file). */
  editable: boolean;
}

export function serverSettingsView(): ServerSettingsView {
  const l = env.serverSettingsLocked;
  return {
    settings: readServerSettings(),
    locked: { siteAddress: l.has("APP_ORIGIN"), proxy: l.has("TRUSTED_PROXY_CIDR"), printer: l.has("PRINTER_MACHINE") },
    editable: env.serverSettingsFile !== "",
  };
}

export class ServerSettingsRejected extends Error {}

/** Apply a change (any of the three sections) and save. Refuses, naming the
 *  problem, anything that wouldn't survive validation, and locked sections. */
export async function saveServerSettings(change: Partial<Record<keyof ServerSettings, unknown>>): Promise<ServerSettings> {
  const view = serverSettingsView();
  if (!view.editable) throw new ServerSettingsRejected("Server settings can't be saved on this install.");
  const next: Record<string, unknown> = { ...structuredClone(view.settings) };
  for (const key of ["siteAddress", "proxy", "printer"] as const) {
    if (change[key] === undefined) continue;
    if (view.locked[key]) throw new ServerSettingsRejected("That setting comes from the container's environment; change it there.");
    next[key] = change[key];
  }
  if (change.siteAddress !== undefined) {
    const site = checkSiteAddress(typeof change.siteAddress === "string" ? change.siteAddress : "");
    if (!site.ok) throw new ServerSettingsRejected(site.error);
  }
  const proxy = change.proxy as { mode?: unknown; address?: unknown } | undefined;
  if (proxy?.mode === "address" && !isProxyAddress(String(proxy.address ?? "").trim())) {
    throw new ServerSettingsRejected("Enter the reverse proxy's IP address, e.g. 192.168.1.20.");
  }
  const printer = change.printer as { machine?: unknown } | undefined;
  const machine = String(printer?.machine ?? "").trim();
  if (printer && machine !== "" && !machines().has(machine)) {
    throw new ServerSettingsRejected("Pick a printer from the list.");
  }
  const saved = normalizeServerSettings(next, machines());
  const file = env.serverSettingsFile;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return saved;
}
