import type { SliceSettings } from "./quote-types";
import type { ModelFormat } from "./filename";

/** Bump whenever OrcaSlicer or a machine/process/filament profile changes in a
 * way that can affect toolpaths. Old rows remain harmless cache misses. */
export const SLICE_PIPELINE_VERSION = "orca-2.5.1-v6";

/**
 * Canonical cache key for a slice-settings combination.
 *
 * Deliberately a readable string rather than a hash: it is short, collision
 * free by construction, and debuggable in the database. Colour and quantity
 * never appear here — they do not affect slicing (see `SliceSettings`).
 */
export function settingsKey(s: SliceSettings): string {
  return `${s.material}:${s.layerHeightUm}:${s.infillPct}:${s.supports}`;
}

/** Persistent slicer-cache identity. File bytes alone are not enough: a text
 * payload can be valid in more than one supported format and parse to different
 * geometry depending on its extension. Version + format therefore form part of
 * every DB/queue cache key, preventing cross-format polyglots from reusing a
 * cheaper slice result. */
export function sliceArtifactKey(
  format: ModelFormat,
  s: SliceSettings,
  printerId: string,
): string {
  // Another printer (or another revision of the owner's presets) slices to
  // different grams and times, so the printer is always part of the key.
  return `${SLICE_PIPELINE_VERSION}:${format}:${settingsKey(s)}@${printerId}`;
}
