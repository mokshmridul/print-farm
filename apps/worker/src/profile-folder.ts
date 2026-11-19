import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prisma, type Prisma } from "@print/db";
import {
  LAYER_HEIGHTS_UM,
  MATERIAL_IDS,
  MAX_PROFILE_UPLOAD_BYTES,
  ProfileUploadRejected,
  defaultMaterialFor,
  firstValue,
  materialFromFolder,
  readOrcaPresets,
  type MaterialId,
  type OrcaProfile,
  type ProfileKind,
  type ProfileSlot,
} from "@print/shared";

/**
 * The profiles folder: OrcaSlicer exports the owner drops in, picked up when
 * the container starts. Three folders, files exactly as OrcaSlicer exports them:
 *
 *   printer/   one printer: a preset .json or an .orca_printer bundle (its
 *              process presets come along)
 *   process/   process presets (.json); each goes to the layer height it prints at
 *   filament/  filament presets (.json / .orca_filament); each goes to the stock
 *              material its filament_type names, or — in filament/<MATERIAL>/ —
 *              to that material (PLA_AESTHETIC, PETG_PREMIUM, OTHER_1, …)
 *
 * The folder is the source of truth for the slots it fills: a new or changed
 * file is test-sliced like an upload and goes live when it passes (until then,
 * and if it fails, what was live stays); a file taken out puts its slot back on
 * the installed preset; and the admin page takes no uploads for those slots.
 */

export const FOLDER_KINDS: Record<string, ProfileKind> = { printer: "machine", process: "process", filament: "filament" };
const KIND_FOLDER: Record<ProfileKind, string> = { machine: "printer", process: "process", filament: "filament" };
const KIND_LABEL: Record<ProfileKind, string> = { machine: "printer", process: "process", filament: "filament" };
const PRESET_FILE = /\.(json|orca_printer|orca_filament)$/i;
const MAX_FILES = 200;

/** One preset found in the folder. */
export interface FolderPreset {
  /** "<path>#<file sha256>#<preset name>": changes whenever the file does. */
  key: string;
  /** Path inside the folder, e.g. "filament/PETG_PREMIUM/Numakers PETG-CF.json". */
  relPath: string;
  name: string;
  kind: ProfileKind;
  raw: OrcaProfile;
  /** The material its filament/<MATERIAL>/ folder names. */
  material: MaterialId | null;
}

/** Something in the folder that can't be used, shown in admin as a failed upload. */
export interface FolderProblem {
  key: string;
  relPath: string;
  name: string;
  slot: ProfileSlot | null;
  raw: OrcaProfile;
  message: string;
}

export interface FolderScan {
  presets: FolderPreset[];
  problems: FolderProblem[];
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Read the folder. A missing folder is an empty one. */
export async function scanProfilesFolder(root: string): Promise<FolderScan> {
  const presets: FolderPreset[] = [];
  const problems: FolderProblem[] = [];
  const files: { relPath: string; abs: string; kind: ProfileKind; material: MaterialId | null }[] = [];

  for (const [folder, kind] of Object.entries(FOLDER_KINDS)) {
    const dir = join(root, folder);
    for (const entry of await listDir(dir)) {
      if (entry.startsWith(".")) continue;
      const abs = join(dir, entry);
      const info = await lstat(abs);
      if (info.isDirectory() && kind === "filament") {
        const material = materialFromFolder(entry);
        for (const inner of await listDir(abs)) {
          if (inner.startsWith(".")) continue;
          const relPath = `${folder}/${entry}/${inner}`;
          if (!PRESET_FILE.test(inner)) continue;
          if (!material) {
            problems.push(fileProblem(relPath, `"${entry}" isn't one of the shop's materials. Name the folder after one: ${MATERIAL_IDS.join(", ")}.`));
            continue;
          }
          files.push({ relPath, abs: join(abs, inner), kind, material });
        }
        continue;
      }
      // Symlinks, sockets and the rest are skipped: only plain files are read.
      if (!info.isFile() || !PRESET_FILE.test(entry)) continue;
      files.push({ relPath: `${folder}/${entry}`, abs, kind, material: null });
    }
  }
  if (files.length > MAX_FILES) {
    problems.push(fileProblem(".", `The profiles folder holds ${files.length} preset files; only the first ${MAX_FILES} are read.`));
    files.length = MAX_FILES;
  }

  for (const file of files) {
    const info = await lstat(file.abs);
    if (!info.isFile()) continue;
    if (info.size > MAX_PROFILE_UPLOAD_BYTES) {
      problems.push(fileProblem(file.relPath, "This file is too large to be an OrcaSlicer preset."));
      continue;
    }
    const bytes = new Uint8Array(await readFile(file.abs));
    const hash = sha256(bytes);
    let found;
    try {
      found = readOrcaPresets(bytes, file.relPath.split("/").pop()!);
    } catch (error) {
      if (!(error instanceof ProfileUploadRejected)) throw error;
      problems.push(fileProblem(file.relPath, error.message, hash));
      continue;
    }
    for (const preset of found) {
      const key = `${file.relPath}#${hash}#${preset.name}`;
      const kind = preset.kind ?? file.kind;
      // A printer bundle carries its process presets (and maybe filaments it
      // was exported with): its processes count as process presets, the rest
      // is left out like an upload leaves it out.
      if (kind !== file.kind && !(file.kind === "machine" && kind === "process")) {
        if (file.kind === "machine" && kind === "filament" && /\.orca_printer$/i.test(file.relPath)) continue;
        problems.push({
          key,
          relPath: file.relPath,
          name: preset.name,
          slot: null,
          raw: preset.raw,
          message: `This is a ${KIND_LABEL[kind]} preset; move it to ${KIND_FOLDER[kind]}/.`,
        });
        continue;
      }
      presets.push({ key, relPath: file.relPath, name: preset.name, kind, raw: preset.raw, material: file.material });
    }
  }
  return { presets, problems };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}

function fileProblem(relPath: string, message: string, hash = ""): FolderProblem {
  return { key: `${relPath}#${hash}`, relPath, name: relPath.split("/").pop() || relPath, slot: null, raw: {}, message };
}

export type FolderFlatten = (kind: ProfileKind, raw: OrcaProfile, peers: readonly OrcaProfile[]) => OrcaProfile;

export interface FolderPlan {
  /** What each slot the folder fills should hold. */
  slots: Map<ProfileSlot, FolderPreset>;
  problems: FolderProblem[];
}

const mm = (um: number) => `${(um / 1000).toFixed(2)} mm`;

/** Decide which slot each preset fills. Pure: the presets are flattened only to
 *  read what they print at (layer height) and with (filament type); the test
 *  slice that decides whether they go live comes later. */
export function planProfilesFolder(scan: FolderScan, flatten: FolderFlatten): FolderPlan {
  const problems = [...scan.problems];
  const peers = scan.presets.map((p) => p.raw);
  const claims = new Map<ProfileSlot, FolderPreset[]>();
  const claim = (slot: ProfileSlot, preset: FolderPreset) => claims.set(slot, [...(claims.get(slot) ?? []), preset]);
  const problem = (preset: FolderPreset, message: string, slot: ProfileSlot | null = null) =>
    problems.push({ key: preset.key, relPath: preset.relPath, name: preset.name, slot, raw: preset.raw, message });

  for (const preset of scan.presets) {
    let flat: OrcaProfile;
    try {
      flat = flatten(preset.kind, preset.raw, peers);
    } catch (error) {
      problem(preset, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (preset.kind === "machine") {
      claim("machine", preset);
    } else if (preset.kind === "process") {
      const height = Number(firstValue(flat.layer_height));
      const um = LAYER_HEIGHTS_UM.find((u) => Math.abs(u / 1000 - height) < 1e-6);
      if (um) claim(`process:${um}`, preset);
      // A printer bundle's other heights are expected; a loose file isn't.
      else if (preset.relPath.startsWith("process/")) {
        problem(preset, `Its layer height (${height || "?"} mm) isn't one this shop quotes (${LAYER_HEIGHTS_UM.map(mm).join(", ")}).`);
      }
    } else {
      const material = preset.material ?? defaultMaterialFor(flat);
      if (material) claim(`filament:${material}`, preset);
      else {
        const type = firstValue(flat.filament_type) || "unknown";
        problem(
          preset,
          `Its filament type (${type}) doesn't say which of the shop's materials it's for. ` +
            `Put it in filament/<MATERIAL>/, one of: ${MATERIAL_IDS.join(", ")}.`,
        );
      }
    }
  }

  const slots = new Map<ProfileSlot, FolderPreset>();
  for (const [slot, presets] of claims) {
    if (presets.length === 1) {
      slots.set(slot, presets[0]!);
      continue;
    }
    // A loose process file beats the same height from the printer bundle.
    const loose = presets.filter((p) => !p.relPath.startsWith("printer/"));
    if (slot.startsWith("process:") && loose.length === 1) {
      slots.set(slot, loose[0]!);
      continue;
    }
    const where = slot === "machine" ? "printer/ holds more than one printer — keep one" : `more than one file is for ${slotWords(slot)}`;
    for (const preset of presets) {
      problem(preset, `Not used: ${where} (${presets.map((p) => p.relPath).join(", ")}).`, slot);
    }
  }
  return { slots, problems };
}

function slotWords(slot: ProfileSlot): string {
  if (slot.startsWith("process:")) return `${mm(Number(slot.slice("process:".length)))} layers`;
  if (slot.startsWith("filament:")) {
    const material = slot.slice("filament:".length);
    return `${material} — put one of them in filament/<MATERIAL>/ to send it to another material`;
  }
  return "the printer";
}

export interface FolderSyncDeps {
  root: string;
  flatten: FolderFlatten;
  /** Queue a batch's test slice. */
  enqueue: (batchId: string) => Promise<void>;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
}

export interface FolderSyncResult {
  queued: number;
  retired: number;
  problems: number;
}

/** Bring the live presets in line with the folder. Run when the worker starts. */
export async function syncProfilesFolder(deps: FolderSyncDeps): Promise<FolderSyncResult> {
  const plan = planProfilesFolder(await scanProfilesFolder(deps.root), deps.flatten);
  const rows = await prisma.slicerProfileUpload.findMany({
    where: { OR: [{ status: "ACTIVE" }, { source: "folder", status: { in: ["PENDING", "TESTING", "FAILED"] } }] },
    select: { id: true, slot: true, source: true, sourceKey: true, status: true },
  });
  const keyed = (status: string, key: string) => rows.some((r) => r.source === "folder" && r.sourceKey === key && r.status === status);

  // Slots the folder no longer fills go back to the installed preset. A slot
  // whose file changed keeps its old preset until the new one passes.
  const stale = rows.filter((r) => r.status === "ACTIVE" && r.source === "folder" && !plan.slots.has(r.slot as ProfileSlot));
  if (stale.length > 0) {
    await prisma.slicerProfileUpload.updateMany({
      where: { id: { in: stale.map((r) => r.id) } },
      data: { status: "RETIRED", checkedAt: new Date() },
    });
  }

  const due: [ProfileSlot, FolderPreset][] = [];
  for (const [slot, preset] of plan.slots) {
    const live = rows.find((r) => r.status === "ACTIVE" && r.slot === slot);
    if (live?.source === "folder" && live.sourceKey === preset.key) continue;
    if (keyed("PENDING", preset.key) || keyed("TESTING", preset.key)) continue;
    // Failed before: tried again on every start, since what it failed on (the
    // printer it builds on, say) may have been fixed since.
    due.push([slot, preset]);
  }

  // Errors already shown for files that are gone, changed or about to be
  // retried are cleared, so the admin page shows only what still stands.
  const standing = new Set(plan.problems.map((p) => p.key));
  const cleared = rows.filter((r) => r.source === "folder" && r.status === "FAILED" && !standing.has(r.sourceKey ?? ""));
  if (cleared.length > 0) {
    await prisma.slicerProfileUpload.updateMany({
      where: { id: { in: cleared.map((r) => r.id) } },
      data: { status: "RETIRED" },
    });
  }

  // A printer goes in with its processes, so they're tested together; each
  // filament is its own batch, so one bad file holds up only itself.
  const printerSide = due.filter(([slot]) => !slot.startsWith("filament:"));
  const batches = [...(printerSide.length ? [printerSide] : []), ...due.filter(([s]) => s.startsWith("filament:")).map((d) => [d])];
  for (const batch of batches) {
    const batchId = randomUUID();
    await prisma.slicerProfileUpload.createMany({
      data: batch.map(([slot, preset]) => ({
        id: randomUUID(),
        batchId,
        slot,
        originalName: `profiles/${preset.relPath}`.slice(0, 300),
        presetName: preset.name,
        raw: preset.raw as Prisma.InputJsonObject,
        status: "PENDING" as const,
        source: "folder",
        sourceKey: preset.key,
      })),
    });
    await deps.enqueue(batchId);
  }

  // Report each problem once: the same file, unchanged, isn't reported again.
  const fresh = plan.problems.filter((p) => !keyed("FAILED", p.key));
  for (const p of fresh) {
    await prisma.slicerProfileUpload.create({
      data: {
        id: randomUUID(),
        batchId: randomUUID(),
        slot: p.slot,
        originalName: `profiles/${p.relPath}`.slice(0, 300),
        presetName: p.name.slice(0, 200),
        raw: p.raw as Prisma.InputJsonObject,
        status: "FAILED",
        error: p.message.slice(0, 2000),
        checkedAt: new Date(),
        source: "folder",
        sourceKey: p.key,
      },
    });
  }

  const result = { queued: due.length, retired: stale.length, problems: plan.problems.length };
  deps.log.info({ ...result, slots: [...plan.slots.keys()] }, "profiles folder synced");
  for (const p of fresh) deps.log.warn({ file: p.relPath }, `profiles folder: ${p.message}`);
  return result;
}

/** Every preset in the folder, as parents for a folder batch's presets: a
 *  filament can build on one of the owner's own, as in a bundle. */
export async function folderPeers(root: string): Promise<OrcaProfile[]> {
  return (await scanProfilesFolder(root)).presets.map((p) => p.raw);
}
