import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrcaProfile, ProfileKind } from "@print/shared";
import { planProfilesFolder, scanProfilesFolder, type FolderFlatten } from "./profile-folder";
import { folderFor, sortProfiles } from "./profile-import";

let root: string;
const put = (path: string, data: object | Uint8Array) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), data instanceof Uint8Array ? data : JSON.stringify(data));
};
const bundle = (entries: Record<string, object>) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(JSON.stringify(v))])));

// Exports as OrcaSlicer writes them: a user preset names its parent and only
// what it changed, so the type/height it prints with may live in the parent.
const PARENTS: Record<string, OrcaProfile> = {
  "Generic PLA": { type: "filament", filament_type: ["PLA"], filament_density: ["1.24"] },
  "Generic PETG": { type: "filament", filament_type: ["PETG"], filament_density: ["1.27"] },
  "Generic PC": { type: "filament", filament_type: ["PC"], filament_density: ["1.2"] },
  "0.20mm Standard @MyKlipper": { type: "process", layer_height: "0.2" },
  "0.28mm Extra Draft @MyKlipper": { type: "process", layer_height: "0.28" },
  "MyKlipper 0.4 nozzle": { type: "machine", nozzle_diameter: ["0.4"] },
};
/** Parent chain only — enough to read what a preset prints at and with. */
const flatten: FolderFlatten = (_kind: ProfileKind, raw, peers) => {
  const parentName = typeof raw.inherits === "string" ? raw.inherits : "";
  const parent = peers.find((p) => p.name === parentName) ?? PARENTS[parentName];
  if (parentName && !parent) throw new Error(`"${String(raw.name)}" inherits "${parentName}", which isn't one of the presets this OrcaSlicer ships.`);
  const own = { ...raw };
  delete own.inherits;
  return { ...(parent ? flatten(_kind, parent, peers) : {}), ...own };
};

const machine = { from: "User", inherits: "MyKlipper 0.4 nozzle", name: "My Voron", printer_settings_id: "My Voron" };
const process = (name: string, parent = "0.20mm Standard @MyKlipper") => ({ from: "User", inherits: parent, name, print_settings_id: name });
const filament = (name: string, parent: string) => ({ from: "User", inherits: parent, name, filament_settings_id: [name] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profiles-folder-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("profiles folder", () => {
  it("reads a missing folder as empty", async () => {
    const scan = await scanProfilesFolder(join(root, "nope"));
    expect(scan).toEqual({ presets: [], problems: [] });
  });

  it("places a printer bundle, loose processes and filaments by what they are", async () => {
    put("printer/voron.orca_printer", bundle({
      "printer/My Voron.json": machine,
      "process/0.20 Voron.json": process("0.20 Voron"),
      "process/0.28 Voron.json": process("0.28 Voron", "0.28mm Extra Draft @MyKlipper"),
      "filament/stray.json": filament("Stray", "Generic PLA"),
    }));
    put("process/0.20 tuned.json", process("0.20 tuned"));
    put("filament/My PLA.json", filament("My PLA", "Generic PLA"));
    put("filament/PETG_PREMIUM/My PETG-CF.json", filament("My PETG-CF", "Generic PETG"));
    put("filament/other-1/My PC.json", filament("My PC", "Generic PC"));
    put("filament/README.txt", new Uint8Array([1, 2, 3]));

    const plan = planProfilesFolder(await scanProfilesFolder(root), flatten);
    const slots = Object.fromEntries([...plan.slots].map(([slot, p]) => [slot, p.name]));
    expect(slots).toEqual({
      machine: "My Voron",
      // The loose file wins over the bundle's process at the same height.
      "process:200": "0.20 tuned",
      "filament:PLA": "My PLA",
      "filament:PETG_PREMIUM": "My PETG-CF",
      "filament:OTHER_1": "My PC",
    });
    // The bundle's 0.28 mm process isn't a height the shop quotes: left out quietly.
    expect(plan.problems).toEqual([]);
  });

  it("explains files it can't place, and changes the key when a file changes", async () => {
    put("filament/My PC.json", filament("My PC", "Generic PC"));
    put("filament/Silk.json", filament("Silk", "Generic PLA"));
    put("filament/Basic.json", filament("Basic", "Generic PLA"));
    put("filament/NOPE/x.json", filament("X", "Generic PLA"));
    put("process/0.28.json", process("0.28", "0.28mm Extra Draft @MyKlipper"));
    put("printer/filament-by-mistake.json", filament("Oops", "Generic PLA"));
    put("process/broken.json", new Uint8Array(strToU8("{ not json")));
    put("process/orphan.json", process("Orphan", "Somebody else's preset"));

    const scan = await scanProfilesFolder(root);
    const plan = planProfilesFolder(scan, flatten);
    expect(plan.slots.size).toBe(0);
    const why = Object.fromEntries(plan.problems.map((p) => [p.relPath, p.message]));
    expect(why["filament/My PC.json"]).toMatch(/filament type \(PC\).*filament\/<MATERIAL>\//);
    expect(why["filament/Silk.json"]).toMatch(/more than one file is for PLA/);
    expect(why["filament/Basic.json"]).toMatch(/more than one file is for PLA/);
    expect(why["filament/NOPE/x.json"]).toMatch(/"NOPE" isn't one of the shop's materials/);
    expect(why["process/0.28.json"]).toMatch(/0.28 mm.*isn't one this shop quotes/);
    expect(why["printer/filament-by-mistake.json"]).toMatch(/filament preset; move it to filament\//);
    expect(why["process/broken.json"]).toMatch(/isn't valid JSON/);
    expect(why["process/orphan.json"]).toMatch(/isn't one of the presets this OrcaSlicer ships/);

    const before = (await scanProfilesFolder(root)).presets.find((p) => p.name === "Silk")!.key;
    put("filament/Silk.json", { ...filament("Silk", "Generic PLA"), filament_flow_ratio: ["0.95"] });
    const after = (await scanProfilesFolder(root)).presets.find((p) => p.name === "Silk")!.key;
    expect(after).not.toBe(before);
    expect(after.startsWith("filament/Silk.json#")).toBe(true);
  });

  it("refuses two printers and reads only plain files", async () => {
    put("printer/a.json", machine);
    put("printer/b.json", { ...machine, name: "Other" });
    writeFileSync(join(root, "elsewhere.json"), JSON.stringify(filament("Linked", "Generic PLA")));
    mkdirSync(join(root, "filament"), { recursive: true });
    symlinkSync(join(root, "elsewhere.json"), join(root, "filament", "linked.json"));
    const plan = planProfilesFolder(await scanProfilesFolder(root), flatten);
    expect(plan.slots.has("machine")).toBe(false);
    expect(plan.problems.filter((p) => /more than one printer/.test(p.message))).toHaveLength(2);
    expect(plan.problems.some((p) => p.relPath.includes("linked"))).toBe(false);
    expect(plan.slots.has("filament:PLA")).toBe(false);
  });
});

describe("installer profile sorting", () => {
  it("sorts exports by what they hold and copies them byte for byte", async () => {
    const src = join(root, "exports");
    const dest = join(root, "profiles");
    mkdirSync(join(src, "nested"), { recursive: true });
    const printerBytes = bundle({ "printer/My Voron.json": machine, "process/0.20.json": process("0.20 Voron") });
    writeFileSync(join(src, "voron.orca_printer"), printerBytes);
    writeFileSync(join(src, "nested", "pla.json"), JSON.stringify(filament("My PLA", "Generic PLA"), null, 4));
    writeFileSync(join(src, "0.16.json"), JSON.stringify(process("0.16")));
    writeFileSync(join(src, "notes.json"), JSON.stringify({ hello: "world" }));
    writeFileSync(join(src, "photo.png"), "x");

    // A printer from an earlier import is replaced: one printer at a time.
    mkdirSync(join(dest, "printer"), { recursive: true });
    writeFileSync(join(dest, "printer", "old.json"), JSON.stringify(machine));

    const result = await sortProfiles(src, dest);
    expect(result.placed.map((p) => p.to).sort()).toEqual(["filament/pla.json", "printer/voron.orca_printer", "process/0.16.json"]);
    expect(result.skipped).toEqual([{ from: "notes.json", why: "It isn't a printer, process or filament preset." }]);
    expect(result.replaced).toEqual(["printer/old.json"]);
    expect(readdirSync(join(dest, "printer"))).toEqual(["voron.orca_printer"]);
    expect(new Uint8Array(readFileSync(join(dest, "printer", "voron.orca_printer")))).toEqual(printerBytes);
    expect(readFileSync(join(dest, "filament", "pla.json"), "utf8")).toBe(JSON.stringify(filament("My PLA", "Generic PLA"), null, 4));
  });

  it("names the folder each kind of export belongs in", () => {
    expect(folderFor(strToU8(JSON.stringify(machine)), "m.json")).toBe("printer");
    expect(folderFor(strToU8(JSON.stringify(process("p"))), "p.json")).toBe("process");
    expect(folderFor(bundle({ "filament/a.json": filament("A", "Generic PLA") }), "a.orca_filament")).toBe("filament");
    expect(() => folderFor(strToU8("[]"), "x.json")).toThrow(/isn't an OrcaSlicer preset/);
  });
});
