import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// There is no built-in printer: a shop quotes only once one is set up — picked
// from OrcaSlicer's list (a generated printer.json), or the owner's own printer
// preset live over the generic stand-in of own-presets mode.

const db = vi.hoisted(() => ({ findMany: vi.fn(async (): Promise<unknown[]> => []) }));
vi.mock("@print/db", () => ({ prisma: { slicerProfileUpload: { findMany: db.findMany } }, Prisma: {} }));

const dir = mkdtempSync(join(tmpdir(), "shop-ready-"));
const spec = (extra: object) => {
  const file = join(dir, `printer-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      id: "myklipper-0-4-nozzle",
      machine: "MyKlipper 0.4 nozzle",
      name: "3D printer",
      vendor: "Custom",
      nozzleMm: 0.4,
      bedMm: [250, 250, 250],
      multiMaterial: false,
      plates: {},
      generated: true,
      ...extra,
    }),
  );
  return file;
};

/** A fresh @/lib/printer: it reads PRINTER_SPEC_FILE once per process. */
async function printerLib(file: string, advanced = "1") {
  vi.resetModules();
  vi.stubEnv("PRINTER_SPEC_FILE", file);
  vi.stubEnv("ADVANCED_PROFILES", advanced);
  return import("@/lib/printer");
}

beforeEach(() => {
  db.findMany.mockReset();
  db.findMany.mockResolvedValue([]);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("shopReady", () => {
  it("is false with no printer set up at all", async () => {
    const { shopReady, getPrinterSpec } = await printerLib("");
    expect(getPrinterSpec()).toMatchObject({ id: "unconfigured", placeholder: true });
    expect(await shopReady()).toBe(false);
  });

  it("is true for a printer picked from OrcaSlicer's list, without asking the database", async () => {
    const { shopReady } = await printerLib(spec({ id: "prusa-mk4-0-4-nozzle", machine: "Prusa MK4 0.4 nozzle" }), "0");
    expect(await shopReady()).toBe(true);
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("waits on the generic stand-in until the owner's printer preset is live", async () => {
    const { shopReady } = await printerLib(spec({ placeholder: true }));
    db.findMany.mockResolvedValue([{ id: "f", slot: "filament:PLA", meta: { presetName: "My PLA" } }]);
    expect(await shopReady()).toBe(false);

    const again = await printerLib(spec({ placeholder: true }));
    db.findMany.mockResolvedValue([
      { id: "m", slot: "machine", meta: { presetName: "My Voron", bedMm: [300, 300, 280] } },
      { id: "f", slot: "filament:PLA", meta: { presetName: "My PLA" } },
    ]);
    expect(await again.shopReady()).toBe(true);
  });

  it("stays closed if the database can't say", async () => {
    const { shopReady } = await printerLib(spec({ placeholder: true }));
    db.findMany.mockRejectedValue(new Error("db down"));
    expect(await shopReady()).toBe(false);
  });
});
