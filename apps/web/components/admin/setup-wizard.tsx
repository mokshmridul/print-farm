"use client";

import { useCallback, useEffect, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_SITE_PROFILE,
  LAYER_HEIGHTS_UM,
  SITE_PROFILE_LIMITS,
  defaultMaterialFor,
  firstValue,
  initialsFor,
  readOrcaPresets,
  siteProfileFieldSchemas,
  type MaterialId,
  type OrcaProfile,
  type ProfileSlot,
  type SiteProfile,
} from "@print/shared";
import type { SlicerProfilesState } from "@/lib/slicer-profiles";
import type { ServerSettingsView } from "@/lib/server-settings";
import { currentBoot, waitForRestart } from "@/lib/restart-client";
import { PrinterPicker } from "./printer-picker";
import { errorMessage } from "./slicer-profiles-editor";

const API = "/api/admin/slicer-profiles";
const HEADERS = { "X-Requested-With": "XMLHttpRequest" };
const POLL_MS = 2500;
const ACCEPT = ".json,.orca_printer,.orca_filament,application/json,application/zip";

type Step = "welcome" | "printer" | "process" | "filament" | "shop" | "done";
type UploadStep = "printer" | "process" | "filament";
const STEP_TITLE: Record<Step, string> = {
  welcome: "Welcome",
  printer: "Printer",
  process: "Process presets",
  filament: "Filaments",
  shop: "Shop details",
  done: "Done",
};
const isUploadStep = (s: Step): s is UploadStep => s === "printer" || s === "process" || s === "filament";

/** A file the owner picked, with the slot the wizard suggests for it. */
interface Picked {
  id: string;
  file: File;
  presetName: string;
  /** "" until the owner picks one; null for a printer bundle (it places itself). */
  slot: ProfileSlot | "" | null;
  status: "ready" | "sending" | "sent" | "error";
  message?: string;
}

const isBundle = (file: File) => /\.orca_(printer|filament)$/i.test(file.name);

/** Layer height a process preset prints at: its own setting, else the height
 *  in its name ("0.20mm Standard @MyKlipper") — a preset that keeps its
 *  parent's height doesn't repeat it. Only a suggestion; the owner can change it. */
function guessProcessSlot(raw: OrcaProfile): ProfileSlot | "" {
  const named = /(\d+(?:\.\d+)?)\s*mm/i.exec(`${String(raw.name ?? "")} ${String(raw.inherits ?? "")}`)?.[1];
  const mm = Number(firstValue(raw.layer_height)) || Number(named);
  const um = LAYER_HEIGHTS_UM.find((u) => Math.abs(u / 1000 - mm) < 1e-6);
  return um ? `process:${um}` : "";
}

/** The material a filament preset is most likely for, from its type, else its
 *  name and parent ("Generic PETG-CF @…"). Only a suggestion. */
function guessFilamentSlot(raw: OrcaProfile): ProfileSlot | "" {
  const direct = defaultMaterialFor(raw);
  if (direct) return `filament:${direct}`;
  const text = `${String(raw.name ?? "")} ${String(raw.inherits ?? "")}`.toUpperCase();
  const rules: [RegExp, MaterialId][] = [
    [/PLA[\s-]?CF/, "PLA_CF"],
    [/PETG[\s-]?CF/, "PETG_PREMIUM"],
    [/SILK|MATTE|GALAXY|MARBLE|WOOD/, "PLA_AESTHETIC"],
    [/PETG|PCTG/, "PETG"],
    [/\bASA\b/, "ASA"],
    [/\bABS\b/, "ABS"],
    [/TPU|TPE/, "TPU"],
    [/PLA/, "PLA"],
  ];
  const hit = rules.find(([re]) => re.test(text));
  return hit ? `filament:${hit[1]}` : "";
}

async function readPresets(file: File): Promise<OrcaProfile[]> {
  try {
    return readOrcaPresets(new Uint8Array(await file.arrayBuffer()), file.name).map((p) => p.raw);
  } catch {
    return [];
  }
}

/** The guided first-run tour: the shop's own OrcaSlicer presets — printer,
 *  then processes, then filaments, dropped in a step at a time — then the
 *  shop's details. Each file goes through the same upload as admin → Slicer
 *  profiles, so nothing is live until its test slice passes. */
export function SetupWizard({
  initial,
  advanced,
  profile,
  server,
  startAt,
}: {
  initial: SlicerProfilesState;
  advanced: boolean;
  /** The shop's details as stored, or null when they couldn't be read. */
  profile: SiteProfile | null;
  /** The server settings (web address, printer from OrcaSlicer's list). */
  server: ServerSettingsView;
  /** Resume here (after the restart that picking a printer from the list takes). */
  startAt?: string;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const has = (kind: "machine" | "process") => state.slots.some((s) => (kind === "machine" ? s.slot === "machine" : s.slot.startsWith("process:")));
  const steps: Step[] = [
    "welcome",
    ...(has("machine") ? (["printer"] as const) : []),
    ...(has("process") ? (["process"] as const) : []),
    "filament",
    "shop",
    "done",
  ];
  const [step, setStep] = useState<Step>(() => (steps as string[]).includes(startAt ?? "") ? (startAt as Step) : "welcome");
  // The printer: one of OrcaSlicer's (set up for the owner) or their own upload.
  const canPickListed = server.editable && !server.locked.printer;
  const [printerSource, setPrinterSource] = useState<"list" | "own">("list");
  const [picked, setPicked] = useState<Record<UploadStep, Picked[]>>({ printer: [], process: [], filament: [] });
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(API, { headers: HEADERS, cache: "no-store" });
    if (res.ok) setState((await res.json()) as SlicerProfilesState);
  }, []);

  useEffect(() => {
    if (!state.busy) return undefined;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [state.busy, refresh]);

  const slotsFor = (s: UploadStep) =>
    state.slots.filter((row) =>
      s === "printer" ? row.slot === "machine" : s === "process" ? row.slot.startsWith("process:") : row.slot.startsWith("filament:"),
    );
  const open = (s: UploadStep) => slotsFor(s).filter((row) => !row.fromFolder);

  // The shop can't quote without its printer, so the tour waits for one: a real
  // printer already (picked from OrcaSlicer's list, or the owner's live preset),
  // or the owner's being test-sliced, or one in the profiles folder.
  const machine = state.slots.find((row) => row.slot === "machine");
  const printerSet = state.printer.ready || !machine || Boolean(machine.testing || machine.fromFolder);
  // No material has a built-in preset, so the shop needs at least one of the
  // owner's to sell anything: live, being tested, or from the folder.
  const filamentSet = state.slots.some(
    (row) => row.slot.startsWith("filament:") && Boolean(row.live || row.testing || row.fromFolder),
  );

  const addFiles = async (s: UploadStep, files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const added: Picked[] = [];
    for (const file of Array.from(files)) {
      const raws = await readPresets(file);
      const raw = raws[0] ?? {};
      let slot: Picked["slot"] = "";
      if (s === "printer") slot = isBundle(file) ? null : "machine";
      else if (s === "process") slot = guessProcessSlot(raw);
      else slot = guessFilamentSlot(raw);
      // A suggestion the folder already fills isn't one the owner can take.
      if (slot && open(s).every((row) => row.slot !== slot)) slot = "";
      added.push({ id: `${file.name}-${file.size}-${file.lastModified}`, file, presetName: String(raw.name ?? file.name), slot, status: "ready" });
    }
    const kept = s === "printer" ? added.slice(-1) : added;
    setPicked((p) => ({ ...p, [s]: s === "printer" ? kept : [...p[s], ...added] }));
    // A printer file places itself: dropping it is uploading it.
    if (s === "printer") await sendItems(s, kept);
  };

  const setSlot = (s: UploadStep, id: string, slot: ProfileSlot | "") =>
    setPicked((p) => ({ ...p, [s]: p[s].map((x) => (x.id === id ? { ...x, slot } : x)) }));
  const remove = (s: UploadStep, id: string) => setPicked((p) => ({ ...p, [s]: p[s].filter((x) => x.id !== id) }));
  const mark = (s: UploadStep, id: string, patch: Partial<Picked>) =>
    setPicked((p) => ({ ...p, [s]: p[s].map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const send = (s: UploadStep) => sendItems(s, picked[s]);

  async function sendItems(s: UploadStep, items: readonly Picked[]) {
    setError(null);
    for (const item of items.filter((x) => x.status === "ready" || x.status === "error")) {
      if (item.slot === "") {
        mark(s, item.id, { status: "error", message: "Choose where it goes first." });
        continue;
      }
      mark(s, item.id, { status: "sending", message: undefined });
      const query = new URLSearchParams({ name: item.file.name });
      if (item.slot) query.set("slot", item.slot);
      const res = await fetch(`${API}?${query}`, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/octet-stream" },
        body: item.file,
      });
      if (!res.ok) {
        mark(s, item.id, {
          status: "error",
          message: res.status === 413 ? "That file is too large (2 MB at most)." : await errorMessage(res, "The upload failed."),
        });
        continue;
      }
      const next = (await res.json()) as SlicerProfilesState & { ignored?: string[] };
      setState(next);
      mark(s, item.id, {
        status: "sent",
        message: next.ignored?.length ? `Not used from it: ${next.ignored.join(", ")}.` : undefined,
      });
    }
  }

  const finish = async () => {
    setFinishing(true);
    const res = await fetch("/api/admin/setup", { method: "POST", headers: HEADERS });
    if (!res.ok) {
      setError(await errorMessage(res, "Couldn't save that setup is done."));
      setFinishing(false);
      return;
    }
    router.push("/admin");
    router.refresh();
  };

  const at = steps.indexOf(step);
  const go = (to: number) => setStep(steps[Math.max(0, Math.min(steps.length - 1, to))]!);
  const blocked = (step === "printer" && !printerSet) || (step === "filament" && !filamentSet);
  const [shopName, setShopName] = useState(profile?.brandName ?? DEFAULT_SITE_PROFILE.brandName);

  return (
    <div className="mt-3">
      <h1 className="text-2xl font-[700] tracking-tight">Set up your shop</h1>

      <ol className="mt-5 flex flex-wrap gap-2 text-xs" aria-label="Setup steps">
        {steps.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setStep(s)}
              // Past the printer only once there is one.
              disabled={!printerSet && i > steps.indexOf("printer") && steps.includes("printer")}
              aria-current={s === step ? "step" : undefined}
              className={`rounded-full border px-3 py-1 disabled:opacity-40 ${s === step ? "border-accent text-accent" : i < at ? "border-line text-muted" : "border-line text-faint"}`}
            >
              {i + 1}. {STEP_TITLE[s]}
            </button>
          </li>
        ))}
      </ol>

      <section className="tile mt-4 space-y-4 p-5">
        {step === "welcome" ? (
          <Welcome advanced={advanced} steps={steps} printerName={state.printer.name} />
        ) : isUploadStep(step) ? (
          <>
            {step === "printer" && canPickListed ? (
              <div className="flex flex-wrap gap-2 text-sm" role="radiogroup" aria-label="Where your printer comes from">
                {(
                  [
                    ["list", "Pick it from OrcaSlicer's list"],
                    ["own", "Upload my own OrcaSlicer preset"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={printerSource === value}
                    onClick={() => setPrinterSource(value)}
                    className={`rounded-full border px-3 py-1.5 ${printerSource === value ? "border-accent text-accent" : "border-line text-muted"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            {step === "printer" && canPickListed && printerSource === "list" ? (
              <ListedPrinter />
            ) : (
            <>
            <UploadIntro step={step} />
            <DropZone
              key={step}
              disabled={open(step).length === 0}
              multiple={step !== "printer"}
              label={step === "printer" ? "Drop your printer bundle here" : step === "process" ? "Drop process presets here" : "Drop filament presets here"}
              types={step === "printer" ? ".orca_printer or .json" : step === "process" ? ".json" : ".json or .orca_filament"}
              onFiles={(files) => void addFiles(step, files)}
            />
            {open(step).length === 0 ? <p className="text-xs text-faint">All of these come from the profiles folder on the server.</p> : null}

            {picked[step].length > 0 ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {picked[step].map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 text-sm">
                    <div className="min-w-[12rem] flex-1">
                      <p className="font-[600]">{item.presetName}</p>
                      <p className="text-xs text-faint">{item.file.name}</p>
                      {item.message ? (
                        <p className={`mt-0.5 text-xs ${item.status === "error" ? "text-danger" : "text-faint"}`}>{item.message}</p>
                      ) : null}
                    </div>
                    {step !== "printer" ? (
                      <select
                        aria-label={`Where ${item.presetName} goes`}
                        className="input-base w-auto text-sm"
                        value={item.slot ?? ""}
                        disabled={item.status === "sending" || item.status === "sent"}
                        onChange={(e) => setSlot(step, item.id, e.target.value as ProfileSlot | "")}
                      >
                        <option value="">Choose…</option>
                        {open(step).map((row) => (
                          <option key={row.slot} value={row.slot}>
                            {row.label.replace(/^(Process|Filament) · /, "")}
                          </option>
                        ))}
                      </select>
                    ) : null}
                    <span className="text-xs text-faint">
                      {item.status === "sending" ? "Uploading…" : item.status === "sent" ? "Uploaded — test-slicing below" : null}
                    </span>
                    {item.status !== "sent" && item.status !== "sending" ? (
                      <button type="button" className="text-xs text-faint underline" onClick={() => remove(step, item.id)}>
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {step !== "printer" && picked[step].some((x) => x.status === "ready" || x.status === "error") ? (
              <button type="button" className="btn-pill text-sm" onClick={() => void send(step)}>
                Upload and test
              </button>
            ) : null}
            {step === "printer" && picked.printer.some((x) => x.status === "error") ? (
              <button type="button" className="btn-pill text-sm" onClick={() => void send("printer")}>
                Try again
              </button>
            ) : null}

            <SlotList rows={slotsFor(step)} compact printerReady={state.printer.ready} />
            {blocked ? (
              <p className="text-xs text-faint">
                {step === "printer"
                  ? "The shop can't quote without its printer, so this step comes first."
                  : "No material comes with a preset, so the shop needs at least one of yours to sell anything."}{" "}
                You can carry on while it test-slices.
              </p>
            ) : null}
            </>
            )}
          </>
        ) : step === "shop" ? (
          <ShopDetails
            profile={profile}
            server={server}
            onSaved={(saved) => {
              setShopName(saved.brandName);
              go(at + 1);
            }}
          />
        ) : (
          <>
            <p className="text-sm text-muted">
              <b>{shopName}</b> is set up. Here&apos;s what quotes slice with; change any of it later in Filament → Slicer
              profiles, and the shop&apos;s details in Site.
            </p>
            <SlotList rows={state.slots} compact printerReady={state.printer.ready} />
            {state.busy ? <p className="text-xs text-accent">Still test-slicing — you can finish now; it carries on.</p> : null}
            {!state.printer.ready || !state.slots.some((r) => r.slot.startsWith("filament:") && r.live) ? (
              <p className="text-xs text-faint">
                Customers can get quotes as soon as your printer and a filament pass their test slices. Then switch each
                material you sell on under Filament.
              </p>
            ) : (
              <p className="text-xs text-faint">Switch each material you sell on under Filament: only those with a preset can be.</p>
            )}
          </>
        )}
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {at > 0 ? (
          <button type="button" className="btn-ghost text-sm" onClick={() => go(at - 1)}>
            Back
          </button>
        ) : null}
        {step === "welcome" ? (
          <button type="button" className="btn-pill text-sm" onClick={() => go(at + 1)}>
            Start
          </button>
        ) : step === "done" ? (
          <button type="button" className="btn-pill text-sm disabled:opacity-40" disabled={finishing} onClick={() => void finish()}>
            {finishing ? "Saving…" : "Finish"}
          </button>
        ) : step === "shop" ? null : (
          <button type="button" className="btn-pill text-sm disabled:opacity-40" disabled={blocked} onClick={() => go(at + 1)}>
            {isUploadStep(step) && picked[step].length === 0 && !blocked ? "Skip" : "Next"}
          </button>
        )}
        {step !== "done" ? (
          <button type="button" className="text-xs text-faint underline" disabled={finishing} onClick={() => void finish()}>
            Skip setup — I&apos;ll do this later
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Welcome({ advanced, steps, printerName }: { advanced: boolean; steps: readonly Step[]; printerName: string }) {
  const what: Partial<Record<Step, string>> = {
    printer: "Pick your printer from OrcaSlicer's list, or drop in your own OrcaSlicer export. Quotes are sliced with it.",
    process: "Your 0.12, 0.16 and 0.20 mm process presets, if the printer bundle didn't bring them.",
    filament: "The filament presets you print with, one per material you sell. No material comes with one, so you need at least one.",
    shop: "Your shop's name, city and contact details for the site, quotes and PDFs.",
  };
  return (
    <>
      <p className="text-sm text-muted">
        A few short steps and customers can start getting instant quotes. Every preset you upload is test-sliced on a
        20 mm cube before quotes use it, and you can change everything later.
      </p>
      <ol className="space-y-2 text-sm">
        {steps
          .filter((s) => what[s])
          .map((s) => (
            <li key={s} className="flex gap-3">
              <span className="w-4 shrink-0 text-right font-[650] text-accent">{steps.indexOf(s) + 1}</span>
              <span>
                <b>{STEP_TITLE[s]}</b> — {what[s]}
              </span>
            </li>
          ))}
      </ol>
      {advanced ? (
        <p className="text-xs text-faint">
          Have OrcaSlicer open on your computer with your printer set up: you&apos;ll export presets from{" "}
          <b>File → Export</b>. Files go in exactly as OrcaSlicer writes them.
        </p>
      ) : (
        <p className="text-xs text-faint">
          Your printer, the {printerName}, was chosen when the shop was installed; its profiles are ready. Here you can add
          presets for your own materials.
        </p>
      )}
    </>
  );
}

function UploadIntro({ step }: { step: UploadStep }) {
  if (step === "printer") {
    return (
      <p className="text-sm text-muted">
        In OrcaSlicer: <b>File → Export → Export Preset Bundle → Printer bundle</b>, and pick your printer. That gives an{" "}
        <code>.orca_printer</code> file with the printer and its process presets; its 0.12, 0.16 and 0.20 mm processes are
        used for those layer heights. A single printer preset (<code>.json</code>) works too. It uploads as soon as you drop it.
      </p>
    );
  }
  if (step === "process") {
    return (
      <p className="text-sm text-muted">
        Optional if your printer bundle had them. Export a process preset from OrcaSlicer as <code>.json</code>; each one is
        used for the layer height it prints at — check the suggestion before uploading.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted">
      Export each filament preset as <code>.json</code> (or an <code>.orca_filament</code> bundle holding just that
      filament) and check the material it&apos;s for. Silk and matte PLA go to the aesthetic tier, carbon-fibre PETG to
      premium PETG, anything else to one of your own materials. A material without your preset isn&apos;t on sale.
    </p>
  );
}

/** A drop target for OrcaSlicer exports; a click (or Enter) picks files instead. */
function DropZone({
  label,
  types,
  multiple,
  disabled,
  onFiles,
}: {
  label: string;
  /** The file types this step takes, as shown. */
  types: string;
  multiple: boolean;
  disabled: boolean;
  onFiles: (files: FileList) => void;
}) {
  const [over, setOver] = useState(false);
  const drag = (e: DragEvent, on: boolean) => {
    e.preventDefault();
    if (!disabled) setOver(on);
  };
  return (
    <label
      onDragEnter={(e) => drag(e, true)}
      onDragOver={(e) => drag(e, true)}
      onDragLeave={(e) => drag(e, false)}
      onDrop={(e) => {
        drag(e, false);
        if (!disabled && e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
      }}
      className={`block rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--accent)] ${
        disabled
          ? "cursor-not-allowed border-line text-faint opacity-60"
          : over
            ? "cursor-copy border-accent bg-accent/10 text-text"
            : "cursor-pointer border-line text-muted hover:border-accent"
      }`}
    >
      <span className="block font-[650]">{label}</span>
      <span className="mt-1 block text-xs text-faint">
        or click to choose {multiple ? "files" : "a file"} · {types}
      </span>
      <input
        type="file"
        className="sr-only"
        accept={ACCEPT}
        multiple={multiple}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
  );
}

type ShopKey = "brandName" | "city" | "quotationPrefix" | "whatsappNumber" | "email" | "phone" | "address";
const SHOP_FIELDS: { key: ShopKey; label: string; hint?: string; max: number; multiline?: boolean; required?: boolean }[] = [
  { key: "brandName", label: "Shop name", hint: "Header, page titles, PDFs and messages.", max: SITE_PROFILE_LIMITS.brandName, required: true },
  { key: "city", label: "City", hint: "“3D printing · City” and pickup copy.", max: SITE_PROFILE_LIMITS.city },
  { key: "quotationPrefix", label: "Quotation initials", hint: "2–5 capital letters: AP-2026-0001.", max: 5 },
  { key: "whatsappNumber", label: "WhatsApp number", hint: "With country code, e.g. 919876543210. Quotes hand off here.", max: 20 },
  { key: "email", label: "Contact email", max: SITE_PROFILE_LIMITS.email },
  { key: "phone", label: "Phone", max: SITE_PROFILE_LIMITS.phone },
  { key: "address", label: "Address", hint: "Shown on the contact page.", max: SITE_PROFILE_LIMITS.address, multiline: true },
];

/** The shop's identity, saved through admin → Site's own API; everything else
 *  there (accent, materials page, footer) keeps what is stored. */
/** Pick the printer from OrcaSlicer's list: saved as a server setting, which
 *  restarts the shop with that printer's profiles; the tour resumes at the
 *  filaments (the printer's own processes come with it). */
function ListedPrinter() {
  const router = useRouter();
  const [machine, setMachine] = useState("");
  const [multi, setMulti] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "restarting" | "slow">("idle");
  const [error, setError] = useState<string | null>(null);
  const use = async () => {
    setState("saving");
    setError(null);
    const before = await currentBoot();
    const res = await fetch("/api/admin/server-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...HEADERS },
      body: JSON.stringify({ printer: { machine, multiMaterial: multi, displayName: "" } }),
    });
    if (!res.ok) {
      setError(await errorMessage(res, "Couldn't save the printer."));
      setState("idle");
      return;
    }
    setState("restarting");
    if (await waitForRestart(before)) {
      router.push("/admin/setup?step=filament");
      router.refresh();
    } else setState("slow");
  };
  return (
    <>
      <p className="text-sm text-muted">
        Find your printer: its own OrcaSlicer machine and process presets are set up for you. Only single-nozzle, 0.4 mm
        setups are listed; for anything else, upload your own preset.
      </p>
      <PrinterPicker value={machine} onChange={setMachine} disabled={state !== "idle"} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="size-4 accent-[var(--accent)]" />
        It has an AMS, MMU or tool changer (automatic multicolour)
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-pill text-sm disabled:opacity-40" disabled={!machine || state !== "idle"} onClick={() => void use()}>
          {state === "saving" ? "Saving…" : state === "restarting" ? "Setting up the printer…" : "Use this printer"}
        </button>
        <span className="text-xs text-faint">
          {state === "restarting"
            ? "The shop restarts with its profiles — about half a minute."
            : state === "slow"
              ? "This is taking a while. Reload the page in a minute."
              : null}
        </span>
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
    </>
  );
}

function ShopDetails({
  profile,
  server,
  onSaved,
}: {
  profile: SiteProfile | null;
  server: ServerSettingsView;
  onSaved: (saved: SiteProfile) => void;
}) {
  const addressEditable = server.editable && !server.locked.siteAddress;
  const [siteAddress, setSiteAddress] = useState(server.settings.siteAddress);
  const [restarting, setRestarting] = useState(false);
  const base = profile ?? DEFAULT_SITE_PROFILE;
  // The neutral default name isn't the owner's choice: start them on a blank.
  const fresh = base.brandName === DEFAULT_SITE_PROFILE.brandName;
  const [form, setForm] = useState<Record<ShopKey, string>>({
    brandName: fresh ? "" : base.brandName,
    city: base.city,
    quotationPrefix: fresh ? "" : base.quotationPrefix,
    whatsappNumber: base.contact.whatsappNumber,
    email: base.contact.email,
    phone: base.contact.phone,
    address: base.contact.address,
  });
  // Initials follow the name until the owner types their own.
  const [ownInitials, setOwnInitials] = useState(!fresh);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: ShopKey, value: string) =>
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === "brandName" && !ownInitials) next.quotationPrefix = value.trim() ? initialsFor(value) : "";
      return next;
    });
  const invalid = new Set(SHOP_FIELDS.filter((f) => !siteProfileFieldSchemas[f.key].safeParse(form[f.key].trim()).success).map((f) => f.key));

  const save = async () => {
    if (invalid.size > 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/site", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...HEADERS },
        body: JSON.stringify({
          ...base,
          brandName: form.brandName.trim(),
          city: form.city.trim(),
          quotationPrefix: form.quotationPrefix.trim().toUpperCase(),
          contact: {
            whatsappNumber: form.whatsappNumber.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            address: form.address.trim(),
          },
        }),
      });
      if (!res.ok) {
        setError(await errorMessage(res, "Saving the shop's details failed."));
        return;
      }
      const saved = (await res.json()) as SiteProfile;
      // The web address is a server setting: saving it restarts the shop.
      if (addressEditable && siteAddress.trim() !== server.settings.siteAddress) {
        const before = await currentBoot();
        const put = await fetch("/api/admin/server-settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...HEADERS },
          body: JSON.stringify({ siteAddress: siteAddress.trim() }),
        });
        if (!put.ok) {
          setError(await errorMessage(put, "The web address couldn't be saved."));
          return;
        }
        setRestarting(true);
        await waitForRestart(before);
        setRestarting(false);
      }
      onSaved(saved);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p className="text-sm text-muted">
        How the shop introduces itself. Only the name is required; the rest, and the accent colour, can be changed any
        time in Site.
      </p>
      {addressEditable ? (
        <label className="block text-sm">
          <span className="font-[600]">Web address</span>
          <span className="ml-2 text-xs text-faint">What customers type, e.g. https://print.example.com. Optional for now.</span>
          <input
            type="url"
            value={siteAddress}
            onChange={(e) => setSiteAddress(e.target.value)}
            placeholder="https://print.example.com"
            className="input-base mt-1.5 py-2 text-sm"
          />
        </label>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {SHOP_FIELDS.map((f) => {
          // A blank name (and the initials that follow it) is the hint below, not an error.
          const bad = invalid.has(f.key) && !(form.brandName.trim() === "" && (f.key === "brandName" || f.key === "quotationPrefix"));
          const common = {
            value: form[f.key],
            maxLength: f.max,
            required: f.required,
            "aria-invalid": bad,
            className: `input-base py-2 text-sm ${bad ? "border-[var(--danger)]" : ""}`,
          };
          return (
            <label key={f.key} className={`block text-sm ${f.multiline ? "sm:col-span-2" : ""}`}>
              <span className="font-[600]">{f.label}</span>
              {f.hint ? <span className="ml-2 text-xs text-faint">{f.hint}</span> : null}
              <span className="mt-1.5 block">
                {f.multiline ? (
                  <textarea rows={2} {...common} onChange={(e) => set(f.key, e.target.value)} />
                ) : (
                  <input
                    type="text"
                    {...common}
                    onChange={(e) => {
                      if (f.key === "quotationPrefix") setOwnInitials(true);
                      set(f.key, e.target.value);
                    }}
                  />
                )}
              </span>
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-pill text-sm disabled:opacity-40" disabled={saving || invalid.size > 0} onClick={() => void save()}>
          {restarting ? "Applying the web address…" : saving ? "Saving…" : "Save and continue"}
        </button>
        {invalid.size > 0 ? (
          <span className="text-xs text-faint">{invalid.has("brandName") ? "Give the shop a name to continue." : "Check the highlighted fields."}</span>
        ) : null}
        {error ? <span className="text-xs text-danger">{error}</span> : null}
      </div>
    </>
  );
}

/** Each slot as it stands: what's live, a test in progress, the last failure.
 *  Compact: only the slots with something of the owner's in them (and the
 *  printer), the rest summed up in one line. */
function SlotList({
  rows,
  compact = false,
  printerReady = true,
}: {
  rows: SlicerProfilesState["slots"];
  compact?: boolean;
  /** False while the printer is only the generic stand-in. */
  printerReady?: boolean;
}) {
  const own = (row: SlicerProfilesState["slots"][number]) =>
    row.slot === "machine" || Boolean(row.live || row.testing || row.fromFolder || row.lastError);
  const shown = compact ? rows.filter(own) : rows;
  const hidden = rows.filter((row) => !shown.includes(row));
  const restFilaments = hidden.filter((row) => row.slot.startsWith("filament:")).length;
  const restOther = hidden.length - restFilaments;
  if (shown.length === 0 && hidden.length === 0) return null;
  return (
    <div className="space-y-2">
      {shown.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">
          {shown.map((row) => (
            <li key={row.slot} className="p-3">
              <p className="font-[600]">{row.label}</p>
              <p className="mt-0.5 text-xs text-faint">
                {row.live ? (
                  <span className="text-muted">{row.live.presetName}</span>
                ) : row.slot === "machine" && !printerReady ? (
                  "Not set up yet"
                ) : row.slot.startsWith("filament:") ? (
                  "No preset yet — not on sale"
                ) : (
                  "The printer's own preset"
                )}
                {row.live?.testGrams != null ? ` · test cube ${row.live.testGrams.toFixed(1)} g` : ""}
                {row.testing ? <span className="text-accent"> · test-slicing…</span> : null}
                {row.fromFolder ? <span className="text-accent"> · from the profiles folder</span> : null}
              </p>
              {row.lastError ? <p className="mt-0.5 text-xs text-danger">Didn&apos;t pass, so nothing changed: {row.lastError}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {restOther > 0 ? (
        <p className="text-xs text-faint">
          {restOther} more {restOther === 1 ? "process uses its" : "processes use their"} preset from the printer.
        </p>
      ) : null}
      {restFilaments > 0 ? (
        <p className="text-xs text-faint">
          {restFilaments} more {restFilaments === 1 ? "material has" : "materials have"} no preset yet, so{" "}
          {restFilaments === 1 ? "it isn't" : "they aren't"} on sale.
        </p>
      ) : null}
    </div>
  );
}
