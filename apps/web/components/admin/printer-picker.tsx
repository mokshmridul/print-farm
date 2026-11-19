"use client";

import { useEffect, useMemo, useState } from "react";
import type { PrinterChoice } from "@print/shared";

const vendorLabel = (v: string) => (v === "BBL" ? "Bambu Lab" : v);
/** "Prusa MK4" — OrcaSlicer's model names usually carry the brand already. */
const printerLabel = (p: PrinterChoice) => {
  const vendor = vendorLabel(p.vendor);
  return p.model.toLowerCase().startsWith(vendor.toLowerCase()) ? p.model : `${vendor} ${p.model}`;
};
const presetLabel = (machine: string) => machine.replace(/ ?0\.4 nozzle$/, "");

/** Search OrcaSlicer's printers (built into the image) and pick one. */
export function PrinterPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (machine: string) => void;
  disabled?: boolean;
}) {
  const [printers, setPrinters] = useState<PrinterChoice[] | null>(null);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/printers", { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { printers: PrinterChoice[] }) => live && setPrinters(d.printers))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!printers) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = printers.filter((p) => {
      const text = `${vendorLabel(p.vendor)} ${p.model} ${p.machine}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    return hits.slice(0, 60);
  }, [printers, query]);
  const current = printers?.find((p) => p.machine === value);

  if (failed) return <p className="text-xs text-danger">Couldn&apos;t load the printer list.</p>;
  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={printers ? `Search ${printers.length} printers — e.g. "prusa mk4" or "ender 3"` : "Loading printers…"}
        aria-label="Search printers"
        disabled={disabled || !printers}
        className="input-base py-2 text-sm"
      />
      {current ? (
        <p className="text-sm">
          Selected: <b>{printerLabel(current)}</b>{" "}
          <span className="text-xs text-faint">({current.machine}, {current.bed.replace(/x/g, " × ")} mm)</span>
        </p>
      ) : null}
      {query.trim() !== "" ? (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm" role="listbox" aria-label="Printers">
          {shown.length === 0 ? <li className="p-3 text-xs text-faint">No printer matches. Try fewer words, or upload your own preset.</li> : null}
          {shown.map((p) => (
            <li key={p.machine}>
              <button
                type="button"
                role="option"
                aria-selected={p.machine === value}
                disabled={disabled}
                onClick={() => {
                  onChange(p.machine);
                  setQuery("");
                }}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-bg ${p.machine === value ? "text-accent" : ""}`}
              >
                <span>
                  {printerLabel(p)}
                  {presetLabel(p.machine) !== p.model ? <span className="ml-2 text-xs text-faint">{presetLabel(p.machine)}</span> : null}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-faint">{p.bed.replace(/x/g, " × ")} mm</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
