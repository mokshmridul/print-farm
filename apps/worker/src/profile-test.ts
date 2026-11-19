import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma, type Prisma } from "@print/db";
import {
  LAYER_HEIGHTS_UM,
  bedOf,
  cleanProfile,
  firstValue,
  isProfileSlot,
  plateFor,
  presetKind,
  slotKind,
  slotLayerUm,
  slotMaterial,
  slotFileName,
  slotMismatch,
  slotInScope,
  type LayerHeightUm,
  type MaterialId,
  type OrcaProfile,
  type ProfileSlot,
  type ProfileUploadMeta,
  type SliceSettings,
} from "@print/shared";
import { config, type ProfileSet } from "./config.js";
import { runSlice } from "./orca.js";
import { ProfileIndex } from "./profile-gen.js";
import { materialiseProfileSet, profileSetsRoot, type SetUpload } from "./profile-set.js";
import { slicerPool } from "./slicer-pool.js";

/**
 * Advanced mode: an owner's upload goes live only after it slices. One upload
 * (a preset .json or a bundle) is one batch: its presets are resolved against
 * the presets this OrcaSlicer ships, checked against their slots, swapped into
 * the live set, and a 20 mm cube is sliced with the result — at each layer
 * height and in each material the batch touches. All pass and the batch
 * replaces what was live; anything fails and nothing changes.
 */

/** A problem with the upload itself, shown to the owner as-is. */
export class ProfileBatchError extends Error {}

export interface UploadRow {
  id: string;
  slot: string | null;
  presetName: string;
  raw: unknown;
  source?: string;
}

export interface PlannedUpload {
  id: string;
  /** Null when the preset was skipped. */
  slot: ProfileSlot | null;
  flattened: OrcaProfile;
  meta: ProfileUploadMeta;
  skipReason?: string;
}

type Flattener = Pick<ProfileIndex, "flattenPreset">;

const mmLabel = (um: number) => `${(um / 1000).toFixed(2)} mm`;

export function slotLabel(slot: ProfileSlot): string {
  const um = slotLayerUm(slot);
  if (um) return `${mmLabel(um)} layers`;
  const material = slotMaterial(slot);
  return material ? `the ${material} filament` : "the printer";
}

function metaFor(flat: OrcaProfile, slot: ProfileSlot | null, presetName: string): ProfileUploadMeta {
  if (slot === "machine") {
    return { presetName, bedMm: bedOf(flat), nozzleMm: Number(firstValue(flat.nozzle_diameter)) };
  }
  if (slot && slotMaterial(slot)) return { presetName, plate: plateFor(flat) };
  return { presetName };
}

/** Resolve and place every preset in a batch, without touching disk or DB.
 *  Presets the owner aimed at a slot go first; a bundle's process presets then
 *  take the layer height they print at, if it's one we quote and still free.
 *  `peers` are further presets a preset may build on (the profiles folder's,
 *  for a batch from it); only the batch's own rows are placed. */
export function planBatch(rows: readonly UploadRow[], index: Flattener, peers: readonly OrcaProfile[] = []): PlannedUpload[] {
  const raws = [...rows.map((r) => r.raw as OrcaProfile), ...peers];
  const taken = new Set<ProfileSlot>();
  const ordered = [...rows].sort((a, b) => Number(!isProfileSlot(a.slot)) - Number(!isProfileSlot(b.slot)));
  return ordered.map((row) => {
    const raw = row.raw as OrcaProfile;
    let slot: ProfileSlot | null = isProfileSlot(row.slot) ? row.slot : null;
    // Resolve as what the preset says it is, so one dropped in the wrong slot
    // is reported as the wrong kind rather than as an unknown parent.
    const kind = presetKind(raw) ?? (slot ? slotKind(slot) : "process");
    let flattened: OrcaProfile;
    try {
      flattened = index.flattenPreset(kind, raw, raws);
    } catch (error) {
      throw new ProfileBatchError(`${row.presetName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let skipReason: string | undefined;
    if (!slot) {
      const mm = Number(firstValue(flattened.layer_height));
      const um = LAYER_HEIGHTS_UM.find((u) => Math.abs(u / 1000 - mm) < 1e-6);
      if (um) slot = `process:${um}`;
      else skipReason = `Skipped: ${mm || "?"} mm layers aren't one of the heights this shop quotes (${LAYER_HEIGHTS_UM.map(mmLabel).join(", ")}).`;
    }
    if (slot && taken.has(slot)) {
      skipReason = `Skipped: another preset in this upload already covers ${slotLabel(slot)}.`;
      slot = null;
    }
    if (slot) {
      const mismatch = slotMismatch(flattened, slot);
      if (mismatch) throw new ProfileBatchError(`${row.presetName}: ${mismatch}`);
      taken.add(slot);
    }
    return { id: row.id, slot, flattened, meta: metaFor(flattened, slot, row.presetName), skipReason };
  });
}

export interface TestSlice {
  settings: SliceSettings;
  label: string;
  /** Upload ids whose test grams this slice records. */
  ids: string[];
}

/** The slices that prove a batch: the printer at 0.20 mm and each process at
 *  its height, in `filament` (one of the owner's, or the test-only reference),
 *  and each filament at 0.20 mm — one slice per combination. */
export function testSlicesFor(live: readonly PlannedUpload[], filament: MaterialId = "PLA"): TestSlice[] {
  const tests = new Map<string, TestSlice>();
  for (const upload of live) {
    if (!upload.slot) continue;
    const um: LayerHeightUm = slotLayerUm(upload.slot) ?? 200;
    const material: MaterialId = slotMaterial(upload.slot) ?? filament;
    const key = `${um}:${material}`;
    const test = tests.get(key) ?? {
      settings: { material, layerHeightUm: um, infillPct: 15, supports: "off" },
      label: `${material} at ${mmLabel(um)}`,
      ids: [],
    };
    test.ids.push(upload.id);
    tests.set(key, test);
  }
  return [...tests.values()];
}

/** A closed, outward-facing binary STL cube resting on z = 0. */
export function cubeStl(size = 20): Buffer {
  const s = size;
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]] as const;
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]] as const;
  const out = Buffer.alloc(84 + faces.length * 50);
  out.write("print shop profile test cube", 0, "ascii");
  out.writeUInt32LE(faces.length, 80);
  faces.forEach(([a, b, c], i) => {
    const [p, q, r] = [v[a], v[b], v[c]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const len = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    let at = 84 + i * 50;
    for (const value of [...n.map((x) => x / len), ...p, ...q, ...r]) {
      out.writeFloatLE(value, at);
      at += 4;
    }
  });
  return out;
}

/** OrcaSlicer's universal PLA, used only to test-slice a printer or process
 *  preset when the owner has no filament live yet. Written into the throwaway
 *  test set alone: it is never sold, quoted or sliced with for a customer. */
export const REFERENCE_FILAMENT = "Generic PLA @System";

export interface ProfileBatchDeps {
  index: () => Flattener;
  slice?: typeof runSlice;
  /** Advanced mode: every slot may be uploaded. Otherwise only filament slots
   *  (slotInScope) — the printer and its processes keep the profiles generated
   *  for the printer picked from OrcaSlicer's list. */
  advanced: boolean;
  /** The profiles folder's presets, as parents for a batch from it. */
  folderPeers?: () => Promise<OrcaProfile[]>;
}

let sharedIndex: ProfileIndex | null = null;
/** Orca's bundled presets, indexed once per process (a few thousand files). */
export function orcaIndex(): ProfileIndex {
  sharedIndex ??= new ProfileIndex(config.orcaProfilesRoot);
  return sharedIndex;
}

async function runTestSlices(batchId: string, tests: readonly TestSlice[], set: ProfileSet, slice: typeof runSlice) {
  const cube = cubeStl();
  const cubePath = join(config.workRoot, `profile-test-${batchId}.stl`);
  await mkdir(config.workRoot, { recursive: true, mode: 0o711 });
  await writeFile(cubePath, cube, { mode: 0o600 });
  await chmod(cubePath, 0o600);
  const input = {
    storedPath: cubePath,
    fileHash: createHash("sha256").update(cube).digest("hex"),
    sizeBytes: cube.length,
    format: "stl",
  };
  const grams = new Map<string, number>();
  try {
    for (const [i, test] of tests.entries()) {
      const workDir = join(config.workRoot, `profile-test-${batchId}-${i}`);
      const identity = await slicerPool.acquire();
      let outcome;
      try {
        outcome = await slice(input, test.settings, workDir, identity, undefined, set);
      } finally {
        await rm(workDir, { recursive: true, force: true });
        slicerPool.release(identity);
      }
      if (!outcome.ok) {
        throw new ProfileBatchError(
          `The test slice (${test.label}) failed, so nothing was changed: ${outcome.errorMessage ?? outcome.errorCode ?? "unknown error"}`,
        );
      }
      for (const id of test.ids) grams.set(id, outcome.filamentGrams ?? 0);
    }
  } finally {
    await rm(cubePath, { force: true });
  }
  return grams;
}

/** Put the reference filament in a test set as `material`'s preset. */
async function writeReferenceFilament(set: ProfileSet, index: Flattener, material: MaterialId): Promise<void> {
  const machine = JSON.parse(await readFile(join(set.dir, set.machineFile), "utf8")) as OrcaProfile;
  const machineName = String(machine.name ?? set.spec.machine);
  const flat = index.flattenPreset("filament", { name: "Reference PLA (test only)", inherits: REFERENCE_FILAMENT }, []);
  const file = join(set.dir, slotFileName(`filament:${material}`, set.machineFile));
  await writeFile(file, JSON.stringify(cleanProfile(flat, "filament", "Reference PLA (test only)", machineName)), { mode: 0o644 });
  await chmod(file, 0o644);
}

export async function markBatchFailed(batchId: string, message: string): Promise<void> {
  await prisma.slicerProfileUpload.updateMany({
    where: { batchId, status: { in: ["PENDING", "TESTING"] } },
    data: { status: "FAILED", error: message.slice(0, 2000), checkedAt: new Date() },
  });
}

export async function processProfileBatch(batchId: string, deps: ProfileBatchDeps): Promise<void> {
  const rows = await prisma.slicerProfileUpload.findMany({
    where: { batchId, status: { in: ["PENDING", "TESTING"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, slot: true, presetName: true, raw: true, source: true },
  });
  if (rows.length === 0) return;
  await prisma.slicerProfileUpload.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: "TESTING" },
  });

  try {
    const peers = rows.some((r) => r.source === "folder") && deps.folderPeers ? await deps.folderPeers() : [];
    const planned = planBatch(rows, deps.index(), peers);
    let live = planned.filter((p): p is PlannedUpload & { slot: ProfileSlot } => p.slot !== null);
    const skipped = planned.filter((p) => p.slot === null);
    if (live.length === 0) {
      throw new ProfileBatchError(skipped[0]?.skipReason ?? "Nothing in this upload could be used.");
    }
    // The web only queues in-scope slots; this is the backstop.
    const outOfScope = live.find((p) => !slotInScope(p.slot, deps.advanced));
    if (outOfScope) {
      throw new ProfileBatchError(
        "Only filament presets can be uploaded on this install. Your printer and its processes use the profiles made for the printer picked when installing (advanced mode changes that).",
      );
    }
    const active = await prisma.slicerProfileUpload.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, slot: true, meta: true, flattened: true, source: true },
    });
    // An upload never replaces what the profiles folder fills: the web refuses
    // those slots up front, and a bundle's process presets — placed only here —
    // are skipped when their height comes from the folder.
    if (!rows.some((r) => r.source === "folder")) {
      const folder = new Set(active.filter((a) => a.source === "folder").map((a) => a.slot));
      for (const p of live.filter((l) => folder.has(l.slot))) {
        skipped.push({ ...p, slot: null, skipReason: `Skipped: ${slotLabel(p.slot)} — that comes from the profiles folder on the server.` });
      }
      live = live.filter((l) => !folder.has(l.slot));
      if (live.length === 0) throw new ProfileBatchError(skipped[skipped.length - 1]!.skipReason!);
    }
    const slots = live.map((p) => p.slot);
    const others = active.filter((a) => !(slots as readonly (string | null)[]).includes(a.slot));
    const candidate: SetUpload[] = [
      ...others.flatMap((o) =>
        isProfileSlot(o.slot) && slotInScope(o.slot, deps.advanced) && o.flattened
          ? [{ id: o.id, slot: o.slot, meta: o.meta, flattened: o.flattened as OrcaProfile }]
          : [],
      ),
      ...live.map((p) => ({ id: p.id, slot: p.slot, meta: p.meta, flattened: p.flattened })),
    ];

    const dir = join(profileSetsRoot(), `test-${batchId}`);
    await rm(dir, { recursive: true, force: true });
    const set = await materialiseProfileSet(candidate, dir);
    // Printer and process presets are proved with one of the owner's live
    // filaments; with none yet, with the test-only reference filament.
    const owned = candidate.flatMap((c) => slotMaterial(c.slot) ?? []);
    const filament: MaterialId = owned.includes("PLA") ? "PLA" : (owned[0] ?? "PLA");
    const tests = testSlicesFor(live, filament);
    let grams: Map<string, number>;
    try {
      if (!owned.includes(filament) && tests.some((t) => t.settings.material === filament)) {
        await writeReferenceFilament(set, deps.index(), filament);
      }
      grams = await runTestSlices(batchId, tests, set, deps.slice ?? runSlice);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const checkedAt = new Date();
    await prisma.$transaction([
      prisma.slicerProfileUpload.updateMany({
        where: { status: "ACTIVE", slot: { in: slots } },
        data: { status: "RETIRED" },
      }),
      ...live.map((p) =>
        prisma.slicerProfileUpload.update({
          where: { id: p.id },
          data: {
            status: "ACTIVE",
            slot: p.slot,
            flattened: p.flattened as Prisma.InputJsonValue,
            meta: p.meta as Prisma.InputJsonValue,
            testGrams: grams.get(p.id) ?? null,
            error: null,
            checkedAt,
          },
        }),
      ),
      ...skipped.map((p) =>
        prisma.slicerProfileUpload.update({
          where: { id: p.id },
          data: { status: "SKIPPED", error: p.skipReason ?? null, checkedAt },
        }),
      ),
    ]);
  } catch (error) {
    if (!(error instanceof ProfileBatchError)) throw error;
    await markBatchFailed(batchId, error.message);
  }
}
