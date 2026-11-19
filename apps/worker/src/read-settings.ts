/**
 * The container's reader for the owner's server settings
 * (/data/config/settings.json, written by the web in admin → Settings →
 * Server and the first-run tour). Runs as root at boot and whenever the file
 * changes; the file comes from the unprivileged web, so it is validated here
 * again — field by field, the printer against the image's own list — and
 * printed as plain NAME=value lines the shell reads without evaluating.
 *
 *   node /opt/tools/read-settings.mjs <settings.json> <printers.tsv>
 */
import { readFileSync, statSync } from "node:fs";
import { normalizeServerSettings, parsePrinterList, serverSettingsEnv } from "@print/shared";

const MAX_BYTES = 64 * 1024;

export function readSettings(file: string, printerList: string): Record<string, string> {
  let raw: unknown = {};
  try {
    if (statSync(file).size > MAX_BYTES) throw new Error(`${file} is larger than ${MAX_BYTES} bytes`);
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const printers = new Set(parsePrinterList(readFileSync(printerList, "utf8")).map((p) => p.machine));
  return serverSettingsEnv(normalizeServerSettings(raw, printers));
}

const entry = process.argv[1] ?? "";
if (/read-settings\.[cm]?[jt]s$/.test(entry)) {
  const [file, list] = process.argv.slice(2);
  if (!file || !list) {
    process.stderr.write("usage: read-settings <settings.json> <printers.tsv>\n");
    process.exit(64);
  }
  try {
    for (const [name, value] of Object.entries(readSettings(file, list))) {
      if (value && !/[\r\n]/.test(value)) process.stdout.write(`${name}=${value}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
