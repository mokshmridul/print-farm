import { describe, expect, it } from "vitest";
import {
  PROFILE_SLOTS,
  applyActiveProfiles,
  cleanProfile,
  isProfileSlot,
  presetKind,
  profileRevision,
  slotFileName,
  slotMismatch,
} from "./orca-profile";
import { UNCONFIGURED_PRINTER_SPEC, printerReady, type PrinterProfileSpec } from "./printer";

const BASE: PrinterProfileSpec = { ...UNCONFIGURED_PRINTER_SPEC, id: "generic", placeholder: undefined };

const machine = {
  printer_settings_id: "My Voron",
  nozzle_diameter: ["0.4"],
  printable_area: ["0x0", "300x0", "300x300", "0x300"],
  printable_height: "280",
};

describe("orca profile slots", () => {
  it("covers the printer, three layer heights and every material", () => {
    expect(PROFILE_SLOTS).toContain("machine");
    expect(PROFILE_SLOTS).toContain("process:160");
    expect(PROFILE_SLOTS).toContain("filament:PETG_PREMIUM");
    expect(PROFILE_SLOTS).toContain("filament:OTHER_4");
    expect(PROFILE_SLOTS).toHaveLength(1 + 3 + 8 + 4);
    expect(isProfileSlot("process:280")).toBe(false);
    expect(isProfileSlot("filament:NYLON")).toBe(false);
  });

  it("names the files the worker loads", () => {
    expect(slotFileName("process:120", "machine.json")).toBe("process.0.12.json");
    expect(slotFileName("filament:PLA_AESTHETIC", "machine.json")).toBe("filament.pla-aesthetic.json");
    expect(slotFileName("machine", "machine.json")).toBe("machine.json");
  });

  it("recognises a preset's kind from what OrcaSlicer exports", () => {
    expect(presetKind(machine)).toBe("machine");
    expect(presetKind({ filament_settings_id: ["My PLA"], inherits: "Generic PLA" })).toBe("filament");
    expect(presetKind({ print_settings_id: "0.2 fast" })).toBe("process");
    expect(presetKind({ type: "filament", layer_height: "0.2" })).toBe("filament");
    expect(presetKind({ name: "mystery" })).toBeNull();
  });
});

describe("cleanProfile", () => {
  it("strips anything that would run or send something beyond slicing", () => {
    const cleaned = cleanProfile(
      {
        layer_height: "0.2",
        post_process: ["/bin/sh -c 'curl evil'"],
        print_host: "octopi.local",
        printhost_apikey: "secret",
        filename_format: "../../x.gcode",
        filament_notes: "",
        inherits: "0.20mm Standard",
        compatible_printers_condition: "printer_notes=~/.*/",
      },
      "process",
      "My 0.20",
      "Voron 2.4",
    );
    expect(cleaned).toEqual({
      layer_height: "0.2",
      type: "process",
      name: "My 0.20",
      from: "system",
      instantiation: "true",
      compatible_printers: ["Voron 2.4"],
    });
  });
});

describe("slotMismatch", () => {
  it("accepts a preset that fits its slot", () => {
    expect(slotMismatch(machine, "machine")).toBeNull();
    expect(slotMismatch({ layer_height: "0.16" }, "process:160")).toBeNull();
    expect(slotMismatch({ filament_type: ["PETG"], filament_density: ["1.27"] }, "filament:PETG")).toBeNull();
  });

  it("explains every way a preset can miss its slot", () => {
    expect(slotMismatch({ filament_type: ["PLA"] }, "machine")).toMatch(/filament preset; this slot needs a printer/);
    expect(slotMismatch({ ...machine, nozzle_diameter: ["0.4", "0.4"] }, "machine")).toMatch(/single-extruder/);
    expect(slotMismatch({ ...machine, printable_area: [] }, "machine")).toMatch(/build volume/);
    expect(slotMismatch({ layer_height: "0.28" }, "process:200")).toMatch(/0.28 mm layer height; this slot is 0.20 mm/);
    expect(slotMismatch({ filament_type: ["PETG"], filament_density: ["1.27"] }, "filament:PLA")).toMatch(/PETG; this slot needs a PLA/);
    expect(slotMismatch({ filament_type: ["ABS"] }, "filament:ABS")).toMatch(/density/);
  });
});

describe("applyActiveProfiles", () => {
  const uploads = [
    { id: "b", slot: "machine", meta: { presetName: "Voron 2.4 300", bedMm: [300, 300, 280], nozzleMm: 0.6 } },
    { id: "a", slot: "filament:PETG", meta: { presetName: "My PETG", plate: "High Temp Plate" } },
  ];

  it("leaves the printer untouched with nothing live", () => {
    expect(applyActiveProfiles(BASE, [])).toBe(BASE);
  });

  it("applies the uploads and carries their revision in the id", () => {
    const spec = applyActiveProfiles(BASE, uploads);
    expect(spec.id).toBe(`generic-r${profileRevision(["a", "b"])}`);
    expect(spec.id).toMatch(/^[a-z0-9-]+$/);
    expect(spec.bedMm).toEqual([300, 300, 280]);
    expect(spec.nozzleMm).toBe(0.6);
    expect(spec.plates.PETG).toBe("High Temp Plate");
    expect(spec.plates.PLA).toBe(BASE.plates.PLA);
    expect(spec.name).toBe(BASE.name);
  });

  it("is ready to quote only once the owner's own printer preset is live", () => {
    const standIn = { ...BASE, placeholder: true };
    expect(printerReady(UNCONFIGURED_PRINTER_SPEC)).toBe(false);
    expect(printerReady(standIn)).toBe(false);
    // Filament presets alone don't make a printer.
    expect(printerReady(applyActiveProfiles(standIn, [uploads[1]!]))).toBe(false);
    expect(printerReady(applyActiveProfiles(standIn, uploads))).toBe(true);
    expect(printerReady(BASE)).toBe(true);
  });

  it("derives the same revision whatever order the rows come in", () => {
    expect(applyActiveProfiles(BASE, [...uploads].reverse()).id).toBe(
      applyActiveProfiles(BASE, uploads).id,
    );
    expect(profileRevision(["a", "b"])).not.toBe(profileRevision(["a", "c"]));
  });
});

describe("placing a filament from the profiles folder", () => {
  it("sends a filament type that names one tier to it, and nothing else", async () => {
    const { defaultMaterialFor } = await import("./orca-profile");
    expect(defaultMaterialFor({ filament_type: ["PLA"] })).toBe("PLA");
    expect(defaultMaterialFor({ filament_type: ["pla-cf"] })).toBe("PLA_CF");
    expect(defaultMaterialFor({ filament_type: "PETG" })).toBe("PETG");
    expect(defaultMaterialFor({ filament_type: ["TPU"] })).toBe("TPU");
    expect(defaultMaterialFor({ filament_type: ["PETG-CF"] })).toBeNull();
    expect(defaultMaterialFor({ filament_type: ["PC"] })).toBeNull();
    expect(defaultMaterialFor({})).toBeNull();
  });

  it("reads a material folder name in any case, with - or space for _", async () => {
    const { materialFromFolder } = await import("./orca-profile");
    expect(materialFromFolder("PETG_PREMIUM")).toBe("PETG_PREMIUM");
    expect(materialFromFolder("petg-premium")).toBe("PETG_PREMIUM");
    expect(materialFromFolder("Other 1")).toBe("OTHER_1");
    expect(materialFromFolder("silk")).toBeNull();
  });
});
