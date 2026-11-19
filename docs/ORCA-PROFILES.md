# OrcaSlicer profiles & slicing

Every quote is backed by a real headless OrcaSlicer run — no estimation. This
document covers the pinned version, how a shop's profiles are made, and how
the worker invokes the CLI.

## Version

Pinned to **OrcaSlicer v2.5.1** (`ORCA_VERSION` in `docker/Dockerfile`).
The AppImage is extracted at image-build time (`--appimage-extract`; FUSE is
unavailable in containers) into `/opt/orca`, made world-readable (2.5 extracts
much of its tree `0700 root`, which the per-job slicer uid cannot run), and run
via `xvfb-run` because the CLI still initialises wxWidgets/GL on some paths.

Since 2.5 the AppImage ships its system presets only as compiled per-vendor
caches (`resources/profiles/<vendor>.opc`, magic `ZCRO`). Everything here that
reads presets — the worker's profile generation for a shop's printer,
resolving an uploaded preset's parents — needs them as JSON,
so the image also carries the same release's `resources/profiles` from the
OrcaSlicer source tag, pinned by commit (`ORCA_SOURCE_COMMIT`), at
`/opt/orca-profiles`. The build fails unless every vendor's JSON version equals
the version in its `.opc` header, so a commit from another release can't slip in.

2.5 also added `include`: a preset names templates (a printer's G-code, a
filament family's shared settings) whose settings are layered over its parent,
in order, under its own keys. The flattener resolves it the way OrcaSlicer
does; the CLI never sees an `include`.

The persistent cache version is independently pinned in
`packages/shared/src/settings-key.ts`. Any Orca/profile change that can affect
toolpaths must bump `SLICE_PIPELINE_VERSION`; otherwise old price statistics
would be reused under the new slicer.

## A shop's profiles

There is no built-in printer and no hand-tuned profile set in the image. A
shop's profiles come from one of two places:

- **A printer from OrcaSlicer's list** (`PRINTER_MACHINE`).
  `apps/worker/src/profile-gen.ts` builds the set from the presets this
  OrcaSlicer ships when the container starts, into `/data/printer`:
  - `machine.json`: the printer's machine preset;
  - `process.0.12.json` / `.0.16.json` / `.0.20.json`: its process presets
    (a missing height is derived from its closest one);
  - `printer.json`: the printer's description (name, build volume) that the
    worker and website read.

  There are **no filament presets** in it: no material has a built-in one.
  Each is sold only once the owner's own filament preset for it is live
  (`materialProblem` in `packages/shared/src/catalog-availability.ts`), and
  the worker refuses a customer slice for a material without one.
- **The owner's own OrcaSlicer presets** (advanced mode: guided setup, admin →
  Slicer profiles, or the profiles folder). They are swapped into a set
  generated from OrcaSlicer's generic Klipper (or Marlin / RRF / Repetier)
  printer. That base is marked `placeholder` in `printer.json`, and the shop
  takes no quotes until the owner's own printer preset is live.

With no `PRINTER_MACHINE` at all, the container starts in advanced mode on
that placeholder: customers see "not taking quotes yet", and upload, slice and
checkout answer `503 SHOP_NOT_READY` until a printer preset passes its test
slice.

Each material tier maps to one filament profile file (`filamentProfile` in
`apps/worker/src/config.ts`), written from the owner's live upload.

OrcaSlicer's bundled presets (`/opt/orca-profiles`) are reference data only:
uploads name one as their parent, and a printer or process upload with no
filament of the owner's live yet is test-sliced with OrcaSlicer's `Generic PLA
@System` (`REFERENCE_FILAMENT` in `apps/worker/src/profile-test.ts`), written
only into the throwaway test set.

**Grams — and therefore price — scale with `filament_density ×
filament_flow_ratio`** of the filament preset, not density alone. The
catalog's densities are informational only.

**Why flattened?** The stock profiles use `inherits:` chains. The OrcaSlicer CLI
does **not** resolve inheritance when given a profile directly — an un-flattened
profile yields `filament_density = 0` and empty weights. So every profile is
flattened (its full inheritance chain and `include`s merged) before it is used.

## How the worker slices

Per job (`apps/worker/src/orca.ts`):

1. Load the flattened process profile for the chosen layer height and **merge the
   customer's overrides into it** (the CLI can't take a partial override file):
   - infill → `sparse_infill_density = "<n>%"`
   - supports Off → `enable_support = "0"`; Auto → `"1"`; Always → `"1"` +
     `support_threshold_angle = "80"`
   Write the complete profile to `job-process.json`.
2. Invoke (essential flags):
   ```
   XDG_RUNTIME_DIR=/tmp/xdg xvfb-run -a /opt/orca/AppRun \
     --datadir <tmp> \
     --load-settings "machine.json;job-process.json" \
     --load-filaments "filament.<material>.json" \
     --orient 1 --arrange 1 --slice 0 \
     --export-3mf out.3mf --outputdir <workdir> <model>
   ```
   Gotchas baked in: `--export-3mf` takes a **bare** filename + `--outputdir`;
   `XDG_RUNTIME_DIR` must exist (0700) or 3MF export fails.
3. Parse `Metadata/slice_info.config` from the exported 3MF:
   `prediction` (seconds), `weight`/`used_g` (grams), `used_m` (metres),
   `support_used` (bool).

Colour and quantity **never** touch slicing — colour is a record field, quantity
is a price multiplier.

## Thumbnails

The CLI (`--slice 0`) does **not** emit a plate thumbnail, so the worker
rasterises its own from the parsed mesh — a small dependency-free software
renderer (`packages/geometry/src/thumbnail.ts` + `png.ts`), no GL, no native
modules.
Thumbnails are written beside the model file under `uploads/thumbs/`.

## Smoke / upgrade gate

After any Orca or profile change, slice the bundled calibration cube
(`apps/worker/test-fixtures/calibration-cube.stl`) for every material × three
layer heights and confirm the reported grams land in a sane band. A 20 mm cube at
PLA/0.20/15% is ~5 g. If weights come back empty or zero, the inheritance
flattening is broken.
Only deploy after updating the pinned AppImage SHA-256 and cache pipeline
version as well.

The CI HTTP funnel deliberately uses fixed synthetic measurements to test the
upload, BullMQ, checkout, and PDF integration without downloading Orca. It does
not exercise profiles or toolpaths and never replaces this real calibration
cube smoke/upgrade gate.
