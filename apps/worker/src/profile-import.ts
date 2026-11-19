import { copyFile, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { MAX_PROFILE_UPLOAD_BYTES, ProfileUploadRejected, readOrcaPresets } from "@print/shared";

/**
 * Sorting OrcaSlicer exports into the profiles folder (printer/, process/,
 * filament/) for the installer. Files are copied byte for byte — the shop
 * slices with exactly what OrcaSlicer exported — and only sorted by what each
 * one holds. Run inside the image, which has the parser:
 *
 *   node /opt/tools/sort-profiles.mjs <file or folder> <profiles folder>
 */

export type ProfileFolder = "printer" | "process" | "filament";

/** Which folder an exported file belongs in, from what it holds. */
export function folderFor(bytes: Uint8Array, fileName: string): ProfileFolder {
  const presets = readOrcaPresets(bytes, fileName);
  const kinds = new Set(presets.map((p) => p.kind));
  // A printer bundle carries its processes (and maybe filaments): it's the printer.
  if (kinds.has("machine")) return "printer";
  if (kinds.size === 1 && kinds.has("process")) return "process";
  if (kinds.size === 1 && kinds.has("filament")) return "filament";
  throw new ProfileUploadRejected(
    kinds.size > 1 ? "It mixes process and filament presets; export them separately." : "It isn't a printer, process or filament preset.",
  );
}

const PRESET_FILE = /\.(json|orca_printer|orca_filament)$/i;

async function collect(source: string, depth = 0): Promise<string[]> {
  const info = await lstat(source);
  if (info.isFile()) return PRESET_FILE.test(source) ? [source] : [];
  if (!info.isDirectory() || depth > 3) return [];
  const out: string[] = [];
  for (const entry of (await readdir(source)).sort()) {
    if (entry.startsWith(".")) continue;
    out.push(...(await collect(join(source, entry), depth + 1)));
  }
  return out;
}

export interface SortResult {
  placed: { from: string; to: string }[];
  skipped: { from: string; why: string }[];
  /** Earlier printer files taken out, so one printer stays. */
  replaced: string[];
}

export async function sortProfiles(source: string, dest: string): Promise<SortResult> {
  const result: SortResult = { placed: [], skipped: [], replaced: [] };
  const files = await collect(source);
  const sorted: { path: string; folder: ProfileFolder }[] = [];
  for (const path of files) {
    const shown = relative(source, path) || basename(path);
    const info = await lstat(path);
    if (info.size > MAX_PROFILE_UPLOAD_BYTES) {
      result.skipped.push({ from: shown, why: "too large to be an OrcaSlicer preset" });
      continue;
    }
    try {
      sorted.push({ path, folder: folderFor(new Uint8Array(await readFile(path)), basename(path)) });
    } catch (error) {
      if (!(error instanceof ProfileUploadRejected)) throw error;
      result.skipped.push({ from: shown, why: error.message });
    }
  }
  const printers = sorted.filter((s) => s.folder === "printer");
  if (printers.length > 1) {
    for (const p of printers) result.skipped.push({ from: relative(source, p.path) || basename(p.path), why: "more than one printer — import just the one you print with" });
  }
  const usable = sorted.filter((s) => s.folder !== "printer" || printers.length === 1);

  for (const folder of ["printer", "process", "filament"] as const) await mkdir(join(dest, folder), { recursive: true, mode: 0o755 });
  if (usable.some((s) => s.folder === "printer")) {
    // One printer at a time: the new one replaces whatever printer/ held.
    for (const old of await readdir(join(dest, "printer"))) {
      if (old.startsWith(".")) continue;
      await rm(join(dest, "printer", old), { recursive: true, force: true });
      result.replaced.push(`printer/${old}`);
    }
  }
  for (const s of usable) {
    const to = join(s.folder, basename(s.path));
    await copyFile(s.path, join(dest, to));
    result.placed.push({ from: relative(source, s.path) || basename(s.path), to });
  }
  return result;
}

async function main(argv: string[]): Promise<number> {
  const [source, dest] = argv;
  if (!source || !dest) {
    console.error("usage: sort-profiles <file or folder> <profiles folder>");
    return 64;
  }
  const result = await sortProfiles(source, dest);
  for (const r of result.replaced) console.log(`replaced\t${r}`);
  for (const p of result.placed) console.log(`placed\t${p.to}\t${p.from}`);
  for (const s of result.skipped) console.log(`skipped\t${s.from}\t${s.why}`);
  return result.placed.length > 0 ? 0 : 2;
}

const entry = process.argv[1] ?? "";
if (/sort-profiles\.[cm]?[jt]s$/.test(entry)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
