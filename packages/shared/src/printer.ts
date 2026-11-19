import { MATERIAL_IDS, type MaterialId } from "./quote-types";

// Zod-free on purpose (it reaches the browser); parsing printer.json lives in
// printer-schema.ts.

/**
 * The printer this shop quotes for. There is no built-in printer: the owner
 * picks any printer OrcaSlicer ships (the image generates its profile set plus
 * this description as `printer.json`, apps/worker/src/profile-gen.ts) or
 * uploads their own OrcaSlicer presets. Until then the shop is not ready to
 * quote (printerReady).
 */
export interface PrinterProfileSpec {
  /** Stable id; part of the slice cache key for anything but the default. */
  id: string;
  /** Orca machine preset the profiles were generated from. */
  machine: string;
  /** Customer-facing name, e.g. "Prusa MK4". */
  name: string;
  vendor: string;
  nozzleMm: number;
  bedMm: [number, number, number];
  /** Has an AMS/MMU/toolchanger for automatic multicolour (the owner says so). */
  multiMaterial: boolean;
  /** Build plate each material tier prints on (its filament has a temperature for it). */
  plates: Record<MaterialId, string>;
  /** Orca preset each tier's filament profile came from — for the record. */
  filamentPresets?: Partial<Record<MaterialId, string>>;
  generated: boolean;
  /** A generic stand-in, not the owner's printer: own-presets mode before
   *  their printer preset is live, or no printer configured at all. The shop
   *  takes no quotes while it is set. */
  placeholder?: boolean;
}

/** No printer set up yet. Only ever a stand-in — never sliced with for a
 *  customer, because printerReady() is false for it. */
export const UNCONFIGURED_PRINTER_SPEC: PrinterProfileSpec = {
  id: "unconfigured",
  machine: "",
  name: "3D printer",
  vendor: "",
  nozzleMm: 0.4,
  bedMm: [250, 250, 250],
  multiMaterial: false,
  plates: Object.fromEntries(MATERIAL_IDS.map((m) => [m, "Textured PEI Plate"])) as Record<MaterialId, string>,
  generated: false,
  placeholder: true,
};

/** Whether the shop has a real printer to quote with: one picked from
 *  OrcaSlicer's list, or the owner's own printer preset once it is live. */
export function printerReady(spec: Pick<PrinterProfileSpec, "placeholder">): boolean {
  return spec.placeholder !== true;
}
