"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  LAYER_HEIGHTS_UM,
  defaultMaterialFor,
  firstValue,
  readOrcaPresets,
  type MaterialId,
  type OrcaProfile,
  type ProfileSlot,
} from "@print/shared";
import type { SlicerProfilesState } from "@/lib/slicer-profiles";
import { errorMessage } from "./slicer-profiles-editor";

const API = "/api/admin/slicer-profiles";
const HEADERS = { "X-Requested-With": "XMLHttpRequest" };
const POLL_MS = 2500;
const ACCEPT = ".json,.orca_printer,.orca_filament,application/json,application/zip";

type Step = "printer" | "process" | "filament" | "done";
const STEP_TITLE: Record<Step, string> = {
  printer: "Printer",
  process: "Process presets",
  filament: "Filaments",
  done: "Done",
};

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

/** The guided setup: the shop's own OrcaSlicer presets, a step at a time. Each
 *  file goes through the same upload as admin → Slicer profiles, so nothing is
 *  live until its test slice passes. */
export function SetupWizard({ initial, advanced }: { initial: SlicerProfilesState; advanced: boolean }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const has = (kind: "machine" | "process") => state.slots.some((s) => (kind === "machine" ? s.slot === "machine" : s.slot.startsWith("process:")));
  const steps: Step[] = [...(has("machine") ? (["printer"] as const) : []), ...(has("process") ? (["process"] as const) : []), "filament", "done"];
  const [step, setStep] = useState<Step>(steps[0]!);
  const [picked, setPicked] = useState<Record<Step, Picked[]>>({ printer: [], process: [], filament: [], done: [] });
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

  const slotsFor = (s: Step) =>
    state.slots.filter((row) =>
      s === "printer" ? row.slot === "machine" : s === "process" ? row.slot.startsWith("process:") : row.slot.startsWith("filament:"),
    );
  const open = (s: Step) => slotsFor(s).filter((row) => !row.fromFolder);

  const addFiles = async (s: Step, files: FileList | null) => {
    if (!files) return;
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
    setPicked((p) => ({ ...p, [s]: s === "printer" ? added.slice(-1) : [...p[s], ...added] }));
  };

  const setSlot = (s: Step, id: string, slot: ProfileSlot | "") =>
    setPicked((p) => ({ ...p, [s]: p[s].map((x) => (x.id === id ? { ...x, slot } : x)) }));
  const remove = (s: Step, id: string) => setPicked((p) => ({ ...p, [s]: p[s].filter((x) => x.id !== id) }));
  const mark = (s: Step, id: string, patch: Partial<Picked>) =>
    setPicked((p) => ({ ...p, [s]: p[s].map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const send = async (s: Step) => {
    setError(null);
    for (const item of picked[s].filter((x) => x.status === "ready" || x.status === "error")) {
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
  };

  const finish = async () => {
    setFinishing(true);
    const res = await fetch("/api/admin/setup", { method: "POST", headers: HEADERS });
    if (!res.ok) {
      setError(await errorMessage(res, "Couldn't save that setup is done."));
      setFinishing(false);
      return;
    }
    router.push("/admin/filament");
    router.refresh();
  };

  const at = steps.indexOf(step);
  const go = (to: number) => setStep(steps[Math.max(0, Math.min(steps.length - 1, to))]!);

  return (
    <div className="mt-3">
      <h1 className="text-2xl font-[700] tracking-tight">Set up your printer</h1>
      <p className="mt-2 text-sm text-muted">
        Upload the presets you slice with in OrcaSlicer, exactly as OrcaSlicer exports them. Each one is test-sliced on
        a 20 mm cube before quotes use it; anything you skip keeps the preset the installer set up.
      </p>
      {!advanced ? (
        <p className="mt-2 text-xs text-faint">
          This shop uses the installer&apos;s printer profiles, so only your own materials take presets here. To use your
          own printer and processes too, choose &quot;my own presets&quot; at the installer&apos;s printer question, or put
          your exports in the profiles folder on the server.
        </p>
      ) : null}

      <ol className="mt-6 flex flex-wrap gap-2 text-xs">
        {steps.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setStep(s)}
              className={`rounded-full border px-3 py-1 ${s === step ? "border-accent text-accent" : "border-line text-faint"}`}
            >
              {i + 1}. {STEP_TITLE[s]}
            </button>
          </li>
        ))}
      </ol>

      <section className="tile mt-4 space-y-4 p-4">
        {step === "printer" ? (
          <p className="text-sm text-muted">
            In OrcaSlicer: <b>File → Export → Export Preset Bundle → Printer bundle</b>, and pick your printer. That
            gives an <code>.orca_printer</code> file with the printer and its process presets; its 0.12, 0.16 and 0.20 mm
            processes are used for those layer heights. A single printer preset (<code>.json</code>) works too.
          </p>
        ) : step === "process" ? (
          <p className="text-sm text-muted">
            Optional if your printer bundle had them. Export a process preset from OrcaSlicer as <code>.json</code>; each
            one is used for the layer height it prints at — check the suggestion before uploading.
          </p>
        ) : step === "filament" ? (
          <p className="text-sm text-muted">
            Export each filament preset as <code>.json</code> (or an <code>.orca_filament</code> bundle holding just that
            filament) and choose the material it&apos;s for. Silk and matte PLA go to the aesthetic tier, carbon-fibre
            PETG to premium PETG, anything else to one of your own materials.
          </p>
        ) : null}

        {step !== "done" ? (
          <>
            <SlotList rows={slotsFor(step)} />
            {open(step).length > 0 ? (
              <label className="btn-ghost inline-block cursor-pointer text-sm">
                {step === "printer" ? "Choose the printer file" : "Choose files"}
                <input
                  type="file"
                  className="hidden"
                  accept={ACCEPT}
                  multiple={step !== "printer"}
                  aria-label={`${STEP_TITLE[step]}: OrcaSlicer files`}
                  onChange={(e) => {
                    void addFiles(step, e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            ) : (
              <p className="text-xs text-faint">All of these come from the profiles folder on the server.</p>
            )}

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
                      {item.status === "sending" ? "Uploading…" : item.status === "sent" ? "Uploaded — see the test above" : null}
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

            {picked[step].some((x) => x.status === "ready" || x.status === "error") ? (
              <button type="button" className="btn-pill text-sm" onClick={() => void send(step)}>
                Upload and test
              </button>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm text-muted">
              Here&apos;s what quotes slice with now. You can change any of it later in Filament → Slicer profiles.
            </p>
            <SlotList rows={state.slots} />
            {state.busy ? <p className="text-xs text-accent">Still test-slicing — you can finish now; it carries on.</p> : null}
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
        {step !== "done" ? (
          <button type="button" className="btn-pill text-sm" onClick={() => go(at + 1)}>
            {picked[step].length === 0 ? "Skip" : "Next"}
          </button>
        ) : (
          <button type="button" className="btn-pill text-sm disabled:opacity-40" disabled={finishing} onClick={() => void finish()}>
            {finishing ? "Saving…" : "Finish"}
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

/** Each slot as it stands: what's live, a test in progress, the last failure. */
function SlotList({ rows }: { rows: SlicerProfilesState["slots"] }) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line text-sm">
      {rows.map((row) => (
        <li key={row.slot} className="p-3">
          <p className="font-[600]">{row.label}</p>
          <p className="mt-0.5 text-xs text-faint">
            {row.live ? <span className="text-muted">{row.live.presetName}</span> : "Installed preset"}
            {row.live?.testGrams != null ? ` · test cube ${row.live.testGrams.toFixed(1)} g` : ""}
            {row.testing ? <span className="text-accent"> · test-slicing…</span> : null}
            {row.fromFolder ? <span className="text-accent"> · from the profiles folder</span> : null}
          </p>
          {row.lastError ? <p className="mt-0.5 text-xs text-danger">Didn&apos;t pass, so nothing changed: {row.lastError}</p> : null}
        </li>
      ))}
    </ul>
  );
}
