/**
 * Printer profiles for self-hosted shops: turn any single-extruder, 0.4 mm
 * printer that OrcaSlicer ships into the standalone profile set the worker
 * slices with — one machine profile and a process profile per layer height —
 * plus `printer.json`, the printer's description for the rest of the app
 * (build volume, …). There are no filament profiles: every material is sold
 * only once the owner's own OrcaSlicer filament preset for it is live.
 *
 *   node dist/profile-gen.js list [profilesRoot]
 *   node dist/profile-gen.js generate "<machine preset name>" <outDir> [--multi-material] [--placeholder] [--name "<shown name>"] [profilesRoot]
 *
 * The Orca CLI does not resolve `inherits` or `include`, so every profile is
 * flattened the way OrcaSlicer itself loads a system preset: the parent's whole
 * chain, then each `include`d template's own settings in the order listed, then
 * the preset's own keys. A preset's parent may live in another vendor's folder
 * (OrcaFilamentLibrary generics are everyone's fallback), so the index spans
 * every vendor.
 *
 * It reads the presets as JSON. OrcaSlicer 2.5's AppImage ships them only as
 * compiled per-vendor caches (`<vendor>.opc`), so the image carries the same
 * release's JSON presets beside it, at DEFAULT_PROFILES_ROOT (docker/Dockerfile).
 *
 * `--placeholder` marks the set as a generic stand-in (own-presets mode before
 * the owner's printer preset is live): the shop takes no quotes with it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LAYER_HEIGHTS_UM,
  MATERIAL_IDS,
  bedOf,
  STAND_IN_PRINTER_NAME,
  cleanProfile,
  firstValue as first,
  plateFor,
  type MaterialId,
  type OrcaProfile as Profile,
  type PrinterProfileSpec,
  type ProfileKind as Kind,
} from "@print/shared";

export { bedOf, plateFor };

interface IndexEntry {
  vendor: string;
  path: string;
}

export const DEFAULT_PROFILES_ROOT = "/opt/orca-profiles";

/** The plate a material prints on until its own filament preset says. */
const DEFAULT_PLATE = "Textured PEI Plate";

/** Preset metadata — never configuration, so an `include` never carries it in.
 *  (The keys OrcaSlicer's JSON loader keeps out of a preset's config.) */
const PRESET_META_KEYS = new Set([
  "version",
  "is_custom_defined",
  "url",
  "name",
  "type",
  "setting_id",
  "filament_id",
  "from",
  "description",
  "instantiation",
  "inherits",
  "include",
  "renamed_from",
  "__vendor",
]);

/** A preset's `include` list (one name or an array), removed from it. */
function takeIncludes(profile: Profile): string[] {
  const raw = profile.include;
  delete profile.include;
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((n): n is string => typeof n === "string" && n.length > 0);
}

function configOf(profile: Profile): Profile {
  const out: Profile = {};
  for (const [key, value] of Object.entries(profile)) if (!PRESET_META_KEYS.has(key)) out[key] = value;
  return out;
}

// ── Index + flattening ────────────────────────────────────────────────────────
export class ProfileIndex {
  private readonly entries = new Map<string, IndexEntry[]>();

  constructor(readonly root: string) {
    for (const vendor of readdirSync(root)) {
      const vendorDir = join(root, vendor);
      if (!statSync(vendorDir).isDirectory()) continue;
      for (const kind of ["machine", "process", "filament"] as const) {
        const dir = join(vendorDir, kind);
        if (existsSync(dir)) this.walk(dir, vendor, kind);
      }
    }
  }

  private walk(dir: string, vendor: string, kind: Kind) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        this.walk(path, vendor, kind);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      let presetName: unknown;
      try {
        presetName = (JSON.parse(readFileSync(path, "utf8")) as Profile).name;
      } catch {
        continue;
      }
      if (typeof presetName !== "string") continue;
      const key = `${kind}:${presetName}`;
      const list = this.entries.get(key) ?? [];
      list.push({ vendor, path });
      this.entries.set(key, list);
    }
  }

  raw(kind: Kind, name: string, preferVendor?: string): { profile: Profile; vendor: string } | null {
    const list = this.entries.get(`${kind}:${name}`);
    if (!list?.length) return null;
    const hit = list.find((e) => e.vendor === preferVendor) ?? list[0]!;
    return { profile: JSON.parse(readFileSync(hit.path, "utf8")) as Profile, vendor: hit.vendor };
  }

  /** The preset with its whole `inherits` chain merged, its `include`d
   *  templates layered over that in order, and its own keys on top. */
  flatten(kind: Kind, name: string, preferVendor?: string, seen: string[] = []): Profile & { __vendor: string } {
    if (seen.includes(name)) throw new Error(`inheritance cycle: ${[...seen, name].join(" -> ")}`);
    const found = this.raw(kind, name, preferVendor);
    if (!found) throw new Error(`${kind} preset not found: ${name}`);
    const { profile, vendor } = found;
    const parent = typeof profile.inherits === "string" && profile.inherits ? profile.inherits : null;
    delete profile.inherits;
    const includes = takeIncludes(profile);
    const merged = parent ? this.flatten(kind, parent, vendor, [...seen, name]) : { __vendor: vendor };
    for (const include of includes) {
      Object.assign(merged, configOf(this.flatten(kind, include, vendor, [...seen, name])));
    }
    return Object.assign(merged, profile, { __vendor: vendor });
  }

  /** A preset that isn't in the index — one the owner uploaded — with its
   *  `inherits` chain and `include`s resolved: first against presets uploaded
   *  with it (a bundle), then against the presets this OrcaSlicer ships. */
  flattenPreset(kind: Kind, preset: Profile, peers: readonly Profile[] = [], seen: string[] = []): Profile {
    const name = String(preset.name ?? "");
    if (seen.includes(name)) throw new Error(`inheritance cycle: ${[...seen, name].join(" -> ")}`);
    const own: Profile = { ...preset };
    const parent = typeof own.inherits === "string" && own.inherits ? own.inherits : null;
    delete own.inherits;
    const includes = takeIncludes(own);
    const resolve = (ref: string, role: string): Profile => {
      const peer = peers.find((p) => p !== preset && p.name === ref);
      if (peer) return this.flattenPreset(kind, peer, peers, [...seen, name]);
      if (!this.raw(kind, ref)) {
        throw new Error(
          `"${name}" ${role} "${ref}", which isn't one of the presets this OrcaSlicer ships. ` +
            "Export it together with the preset it's based on (as a bundle), or pick a system preset as its parent.",
        );
      }
      return this.flatten(kind, ref);
    };
    const merged: Profile = parent ? resolve(parent, "is based on") : {};
    for (const include of includes) Object.assign(merged, configOf(resolve(include, "includes")));
    return Object.assign(merged, own);
  }

  /** Every instantiable preset of a kind, flattened. */
  *instantiable(kind: Kind): Generator<Profile & { __vendor: string }> {
    for (const [key, list] of this.entries) {
      if (!key.startsWith(`${kind}:`)) continue;
      const name = key.slice(kind.length + 1);
      const raw = JSON.parse(readFileSync(list[0]!.path, "utf8")) as Profile;
      if (raw.instantiation !== "true") continue;
      try {
        yield this.flatten(kind, name, list[0]!.vendor);
      } catch {
        // A broken vendor chain only removes that one preset from the choice.
      }
    }
  }
}

// ── Compatibility ─────────────────────────────────────────────────────────────
const notes = (m: Profile): string => (Array.isArray(m.printer_notes) ? m.printer_notes.join("\n") : String(m.printer_notes ?? ""));

/** Orca's `compatible_printers_condition`, for the forms its bundled presets use:
 *  `printer_notes=~/…/`, `printer_notes!~/…/`, `nozzle_diameter[0]==x` and
 *  `single_extruder_multi_material`, joined by `and`. Unknown forms fail closed. */
export function conditionMatches(condition: string, machine: Profile): boolean {
  if (!condition.trim()) return true;
  for (const raw of condition.split(/\s+and\s+/)) {
    const part = raw.trim().replace(/^\(|\)$/g, "");
    let m = /^printer_notes\s*(=~|!~)\s*\/(.*)\/$/.exec(part);
    if (m) {
      const hit = new RegExp(m[2]!).test(notes(machine));
      if ((m[1] === "=~") !== hit) return false;
      continue;
    }
    m = /^nozzle_diameter\[0\]\s*==\s*([0-9.]+)$/.exec(part);
    if (m) {
      if (Math.abs(Number(first(machine.nozzle_diameter)) - Number(m[1])) > 1e-6) return false;
      continue;
    }
    if (part === "single_extruder_multi_material") {
      if (first(machine.single_extruder_multi_material) !== "1") return false;
      continue;
    }
    return false;
  }
  return true;
}

export function isCompatible(preset: Profile, machineName: string, machine: Profile): boolean {
  const list = Array.isArray(preset.compatible_printers) ? (preset.compatible_printers as string[]) : [];
  if (list.length > 0) return list.includes(machineName);
  return conditionMatches(String(preset.compatible_printers_condition ?? ""), machine);
}

// ── Printer list ──────────────────────────────────────────────────────────────
export interface PrinterChoice {
  vendor: string;
  /** Exact machine preset name — what `generate` takes. */
  machine: string;
  /** Human model name, e.g. "Prusa MK4". */
  model: string;
  bedMm: [number, number, number];
}

/** Single-extruder FFF printers with a 0.4 mm nozzle — the setups our three
 *  layer heights and seven material tiers are defined for. */
export function listPrinters(index: ProfileIndex): PrinterChoice[] {
  const out: PrinterChoice[] = [];
  for (const m of index.instantiable("machine")) {
    const nozzles = Array.isArray(m.nozzle_diameter) ? m.nozzle_diameter : [m.nozzle_diameter];
    if (nozzles.length !== 1 || Number(first(nozzles)) !== 0.4) continue;
    if (String(m.printer_technology ?? "FFF") !== "FFF") continue;
    const bed = bedOf(m);
    if (bed.some((d) => d <= 0)) continue;
    out.push({
      vendor: m.__vendor,
      machine: String(m.name),
      model: String(m.printer_model || m.name).trim(),
      bedMm: bed,
    });
  }
  return out.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model));
}

// ── Choosing presets ──────────────────────────────────────────────────────────
const PROCESS_PREFERENCE: Record<number, RegExp> = {
  120: /fine/i,
  160: /optimal/i,
  200: /standard/i,
};

function pickProcess(
  presets: Profile[],
  machineName: string,
  machine: Profile,
  layerUm: number,
): Profile | null {
  const mm = layerUm / 1000;
  const fits = presets.filter(
    (p) => Math.abs(Number(first(p.layer_height)) - mm) < 1e-6 && isCompatible(p, machineName, machine),
  );
  const preferred = fits.filter((p) => PROCESS_PREFERENCE[layerUm]!.test(String(p.name)));
  return (preferred.length ? preferred : fits).sort((a, b) => String(a.name).length - String(b.name).length)[0] ?? null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface GeneratedSet {
  spec: PrinterProfileSpec;
  files: Record<string, Profile>;
}

/** Build the whole profile set for one printer, without touching the disk. */
export function generateProfiles(
  index: ProfileIndex,
  machineName: string,
  multiMaterial: boolean,
  displayName?: string,
  placeholder = false,
): GeneratedSet {
  const machine = index.flatten("machine", machineName);
  const choice = listPrinters(index).find((p) => p.machine === machineName);
  if (!choice) throw new Error(`${machineName} is not a single-extruder 0.4 mm printer this shop can quote for`);

  const processes = [...index.instantiable("process")];
  const files: Record<string, Profile> = {};
  files["machine.json"] = cleanProfile(machine, "machine", machineName, machineName);

  const compatibleProcesses = processes.filter((p) => isCompatible(p, machineName, machine));
  for (const um of LAYER_HEIGHTS_UM) {
    let preset = pickProcess(processes, machineName, machine, um);
    if (!preset) {
      // About half of Orca's printers lack a 0.16 mm preset, a few a 0.12 mm one:
      // derive it from the printer's own preset closest in layer height, which
      // only differs in layer height for our purposes.
      const target = um / 1000;
      const nearest = [...compatibleProcesses].sort(
        (a, b) =>
          Math.abs(Number(first(a.layer_height)) - target) - Math.abs(Number(first(b.layer_height)) - target) ||
          String(a.name).length - String(b.name).length,
      )[0];
      if (nearest) {
        preset = { ...nearest, layer_height: target.toFixed(2), name: `${target.toFixed(2)}mm (derived from ${String(nearest.name)})` };
      }
    }
    if (!preset) throw new Error(`${machineName}: no process preset compatible with this printer`);
    const label = String(preset.name);
    files[`process.${(um / 1000).toFixed(2)}.json`] = cleanProfile(preset, "process", label, machineName);
  }

  // No filament presets: there are no built-in ones. Each material is sold
  // only once the owner's own filament preset is live, and that preset brings
  // the plate it prints on.
  const plates = Object.fromEntries(MATERIAL_IDS.map((m) => [m, DEFAULT_PLATE])) as Record<MaterialId, string>;

  const spec: PrinterProfileSpec = {
    id: slug(machineName),
    machine: machineName,
    // A stand-in is never named after the generic printer it's made from: the
    // owner's own printer preset names it once live.
    name: displayName || (placeholder ? STAND_IN_PRINTER_NAME : choice.model),
    vendor: choice.vendor,
    nozzleMm: 0.4,
    bedMm: choice.bedMm,
    multiMaterial,
    plates,
    generated: true,
    ...(placeholder ? { placeholder: true } : {}),
  };
  return { spec, files };
}

/** Write a set to `outDir` (worker-readable: 0755 dir, 0644 files). */
export function writeProfileSet(set: GeneratedSet, outDir: string) {
  mkdirSync(outDir, { recursive: true, mode: 0o755 });
  for (const [name, profile] of Object.entries(set.files)) {
    writeFileSync(join(outDir, name), `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o644 });
  }
  writeFileSync(join(outDir, "printer.json"), `${JSON.stringify(set.spec, null, 2)}\n`, { mode: 0o644 });
}

// ── CLI ───────────────────────────────────────────────────────────────────────
export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const multi = rest.includes("--multi-material");
  const placeholder = rest.includes("--placeholder");
  const nameAt = rest.indexOf("--name");
  const displayName = nameAt >= 0 ? rest[nameAt + 1]?.trim().slice(0, 120) : undefined;
  const args = rest.filter(
    (a, i) => a !== "--multi-material" && a !== "--placeholder" && (nameAt < 0 || (i !== nameAt && i !== nameAt + 1)),
  );
  if (command === "list") {
    const index = new ProfileIndex(args[0] ?? DEFAULT_PROFILES_ROOT);
    for (const p of listPrinters(index)) {
      process.stdout.write(`${p.vendor}\t${p.model}\t${p.machine}\t${p.bedMm.join("x")}\n`);
    }
    return;
  }
  if (command === "generate" && args[0] && args[1]) {
    const [machineName, outDir, root] = args as [string, string, string?];
    const set = generateProfiles(new ProfileIndex(root ?? DEFAULT_PROFILES_ROOT), machineName, multi, displayName, placeholder);
    writeProfileSet(set, outDir);
    process.stdout.write(`${set.spec.name}: ${Object.keys(set.files).length} profiles, bed ${set.spec.bedMm.join("×")} mm\n`);
    return;
  }
  process.stderr.write('usage: profile-gen.js list [root] | generate "<machine>" <outDir> [--multi-material] [--placeholder] [--name "<shown name>"] [root]\n');
  process.exitCode = 64;
}

// The worker bundle (dist/index.js) inlines this module through profile-test,
// and there import.meta.url is the bundle's own URL, so the URL check alone
// would run this CLI inside the worker. Require the entry file to be this one.
const entry = process.argv[1] ?? "";
if (/profile-gen\.[cm]?[jt]s$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
