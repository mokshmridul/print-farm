import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  createMany: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@print/db", () => ({
  Prisma: {},
  prisma: { slicerProfileUpload: db },
}));

const { scanProfilesFolder, syncProfilesFolder } = await import("./profile-folder.js");

let root: string;
const put = (path: string, data: object) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(data));
};
// Presets that carry what they print at/with, so flattening is the identity.
const flatten = (_k: unknown, raw: Record<string, unknown>) => raw;
const pla = { type: "filament", name: "My PLA", filament_type: ["PLA"], filament_density: ["1.24"] };
const fine = { type: "process", name: "Fine", layer_height: "0.12" };
const log = { info: vi.fn(), warn: vi.fn() };

async function sync(rows: object[]) {
  db.findMany.mockResolvedValueOnce(rows);
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const result = await syncProfilesFolder({ root, flatten, enqueue, log });
  return { result, enqueue };
}
const keyOf = async (name: string) => (await scanProfilesFolder(root)).presets.find((p) => p.name === name)!.key;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profiles-sync-"));
  vi.clearAllMocks();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("profiles folder sync", () => {
  it("queues new presets: the printer side together, each filament on its own", async () => {
    put("process/fine.json", fine);
    put("filament/pla.json", pla);
    const { result, enqueue } = await sync([]);
    expect(result).toEqual({ queued: 2, retired: 0, problems: 0 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    const batches = db.createMany.mock.calls.map(([arg]) => arg.data);
    expect(batches.map((rows: { slot: string }[]) => rows.map((r) => r.slot))).toEqual([["process:120"], ["filament:PLA"]]);
    expect(batches[1][0]).toMatchObject({ source: "folder", status: "PENDING", originalName: "profiles/filament/pla.json", presetName: "My PLA" });
    expect(batches[1][0].sourceKey).toBe(await keyOf("My PLA"));
  });

  it("leaves a file that's already live alone, and doesn't re-queue one in test", async () => {
    put("filament/pla.json", pla);
    put("process/fine.json", fine);
    const { result } = await sync([
      { id: "a", slot: "filament:PLA", source: "folder", sourceKey: await keyOf("My PLA"), status: "ACTIVE" },
      { id: "b", slot: "process:120", source: "folder", sourceKey: await keyOf("Fine"), status: "TESTING" },
    ]);
    expect(result.queued).toBe(0);
    expect(db.createMany).not.toHaveBeenCalled();
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("puts a slot whose file was taken out back on the installed preset", async () => {
    const { result } = await sync([
      { id: "gone", slot: "filament:PETG", source: "folder", sourceKey: "filament/petg.json#x#My PETG", status: "ACTIVE" },
      { id: "mine", slot: "filament:ABS", source: "upload", sourceKey: null, status: "ACTIVE" },
    ]);
    expect(result.retired).toBe(1);
    expect(db.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["gone"] } }, data: { status: "RETIRED", checkedAt: expect.any(Date) } });
  });

  it("takes a slot back from a web upload, and keeps a changed file's old preset until the new one passes", async () => {
    put("filament/pla.json", pla);
    put("process/fine.json", { ...fine, wall_loops: "3" });
    const { result } = await sync([
      { id: "web", slot: "filament:PLA", source: "upload", sourceKey: null, status: "ACTIVE" },
      { id: "old", slot: "process:120", source: "folder", sourceKey: "process/fine.json#before#Fine", status: "ACTIVE" },
    ]);
    expect(result).toMatchObject({ queued: 2, retired: 0 });
    // Neither live row is retired here: activation replaces them once the test passes.
    expect(db.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "RETIRED", checkedAt: expect.any(Date) }) }));
  });

  it("reports a problem once, retries a failed test, and clears errors that no longer stand", async () => {
    put("filament/pc.json", { type: "filament", name: "My PC", filament_type: ["PC"], filament_density: ["1.2"] });
    put("filament/pla.json", pla);
    const pcKey = (await scanProfilesFolder(root)).presets.find((p) => p.name === "My PC")!.key;
    const plaKey = await keyOf("My PLA");

    const first = await sync([]);
    expect(first.result.problems).toBe(1);
    expect(db.create).toHaveBeenCalledTimes(1);
    expect(db.create.mock.calls[0]![0].data).toMatchObject({ status: "FAILED", source: "folder", sourceKey: pcKey, originalName: "profiles/filament/pc.json" });
    expect(db.create.mock.calls[0]![0].data.error).toMatch(/filament\/<MATERIAL>\//);

    vi.clearAllMocks();
    const second = await sync([
      { id: "p", slot: null, source: "folder", sourceKey: pcKey, status: "FAILED" },
      { id: "t", slot: "filament:PLA", source: "folder", sourceKey: plaKey, status: "FAILED" },
      { id: "old", slot: null, source: "folder", sourceKey: "filament/deleted.json#x#Gone", status: "FAILED" },
    ]);
    expect(db.create).not.toHaveBeenCalled();
    expect(second.result.queued).toBe(1);
    expect(db.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["t", "old"] } }, data: { status: "RETIRED" } });
  });
});
