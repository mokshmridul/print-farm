"use client";

import { useState } from "react";
import type { ProxyMode, RealIpHeader } from "@print/shared";
import type { ServerSettingsView } from "@/lib/server-settings";
import { currentBoot, waitForRestart } from "@/lib/restart-client";
import { PrinterPicker } from "./printer-picker";

const PROXY_OPTIONS: { mode: ProxyMode; label: string; hint: string }[] = [
  { mode: "none", label: "No reverse proxy", hint: "Visitors connect straight to this container." },
  {
    mode: "host",
    label: "A reverse proxy on this computer",
    hint: "SWAG, Nginx Proxy Manager, Caddy or cloudflared on the same machine, reaching the published port.",
  },
  { mode: "address", label: "A reverse proxy at another address", hint: "Another machine, or a proxy container with its own IP." },
];

/** The container's own settings: the web address customers use, which reverse
 *  proxy to trust for visitors' real addresses, and the printer. Saving one
 *  restarts the shop for a few seconds; settings the container's environment
 *  sets are shown locked. */
export function ServerEditor({ initial }: { initial: ServerSettingsView }) {
  const { locked, editable } = initial;
  const [site, setSite] = useState(initial.settings.siteAddress);
  const [mode, setMode] = useState<ProxyMode>(initial.settings.proxy.mode);
  const [address, setAddress] = useState(initial.settings.proxy.address);
  const [header, setHeader] = useState<RealIpHeader>(initial.settings.proxy.header);
  const [lan, setLan] = useState(initial.settings.proxy.lanAccess);
  const [own, setOwn] = useState(initial.settings.printer.machine === "");
  const [machine, setMachine] = useState(initial.settings.printer.machine);
  const [multi, setMulti] = useState(initial.settings.printer.multiMaterial);
  const [name, setName] = useState(initial.settings.printer.displayName);
  const [state, setState] = useState<"idle" | "saving" | "restarting" | "slow">("idle");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    setState("saving");
    const body: Record<string, unknown> = {};
    if (!locked.siteAddress) body.siteAddress = site;
    if (!locked.proxy) body.proxy = { mode, address, header, lanAccess: lan };
    if (!locked.printer) body.printer = { machine: own ? "" : machine, multiMaterial: multi, displayName: name };
    const before = await currentBoot();
    const res = await fetch("/api/admin/server-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(data?.error?.message ?? "Saving failed.");
      setState("idle");
      return;
    }
    setState("restarting");
    const back = await waitForRestart(before);
    if (!back) {
      setState("slow");
      return;
    }
    window.location.reload();
  };

  const field = "input-base mt-1.5 py-2 text-sm";
  const lockNote = (on: boolean, variable: string) =>
    on ? <p className="mt-1 text-xs text-faint">Set by {variable} in the container&apos;s environment; change it there.</p> : null;

  return (
    <details className="tile mt-4 p-0 [&_summary]:list-none" open={initial.settings.siteAddress === "" && !locked.siteAddress}>
      <summary className="flex cursor-pointer items-center justify-between p-4 text-[0.62rem] font-[650] uppercase tracking-[0.14em] text-faint">
        <span>Server · web address, reverse proxy &amp; printer</span>
        <span className="text-faint">edit</span>
      </summary>
      <div className="space-y-6 border-t border-line p-4">
        {!editable ? <p className="text-xs text-faint">These are set by the container on this install.</p> : null}

        <label className="block text-sm">
          <span className="font-[600]">Web address</span>
          <span className="ml-2 text-xs text-faint">What customers type, for links in PDFs, emails and messages.</span>
          <input
            type="url"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="https://print.example.com"
            disabled={locked.siteAddress || !editable}
            className={field}
          />
          {lockNote(locked.siteAddress, "APP_ORIGIN")}
        </label>

        <fieldset disabled={locked.proxy || !editable}>
          <legend className="text-sm font-[600]">Reverse proxy</legend>
          <p className="mt-0.5 text-xs text-faint">
            Who to believe about a visitor&apos;s real address (for fair rate limits). Get this wrong and everyone shares one
            address.
          </p>
          <div className="mt-2 space-y-2">
            {PROXY_OPTIONS.map((o) => (
              <label key={o.mode} className="flex items-start gap-2 text-sm">
                <input type="radio" name="proxy-mode" checked={mode === o.mode} onChange={() => setMode(o.mode)} className="mt-1 accent-[var(--accent)]" />
                <span>
                  {o.label}
                  <span className="block text-xs text-faint">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          {mode === "address" ? (
            <label className="mt-3 block text-sm">
              <span className="font-[600]">Proxy&apos;s IP address</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20" className={field} />
            </label>
          ) : null}
          {mode !== "none" ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="font-[600]">Header with the visitor&apos;s address</span>
                <select value={header} onChange={(e) => setHeader(e.target.value as RealIpHeader)} className={field}>
                  <option value="X-Real-IP">X-Real-IP (nginx, SWAG, Caddy, NPM)</option>
                  <option value="CF-Connecting-IP">CF-Connecting-IP (Cloudflare Tunnel)</option>
                </select>
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={lan} onChange={(e) => setLan(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                Also open to devices on my network directly
              </label>
            </div>
          ) : null}
          {lockNote(locked.proxy, "TRUSTED_PROXY_CIDR")}
        </fieldset>

        <fieldset disabled={locked.printer || !editable}>
          <legend className="text-sm font-[600]">Printer</legend>
          <div className="mt-2 space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="radio" name="printer-source" checked={!own} onChange={() => setOwn(false)} className="mt-1 accent-[var(--accent)]" />
              <span>
                One of OrcaSlicer&apos;s printers
                <span className="block text-xs text-faint">Its own machine and process presets are set up for you.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="printer-source" checked={own} onChange={() => setOwn(true)} className="mt-1 accent-[var(--accent)]" />
              <span>
                My own OrcaSlicer printer preset
                <span className="block text-xs text-faint">Upload it in Filament → Slicer profiles or the setup tour.</span>
              </span>
            </label>
          </div>
          {!own ? (
            <div className="mt-3 space-y-3">
              <PrinterPicker value={machine} onChange={setMachine} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="size-4 accent-[var(--accent)]" />
                It has an AMS, MMU or tool changer (automatic multicolour)
              </label>
            </div>
          ) : null}
          <label className="mt-3 block text-sm">
            <span className="font-[600]">Name customers see</span>
            <span className="ml-2 text-xs text-faint">Optional, e.g. &quot;Voron 2.4 300&quot;.</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={field} />
          </label>
          {lockNote(locked.printer, "PRINTER_MACHINE")}
        </fieldset>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!editable || state !== "idle" || (!own && !locked.printer && machine === "")}
            className="btn-pill text-sm disabled:opacity-40"
          >
            {state === "saving" ? "Saving…" : state === "restarting" ? "Restarting the shop…" : "Save and restart"}
          </button>
          <span className="text-xs text-faint">
            {state === "restarting"
              ? "Applying — this takes a few seconds (longer when the printer changes)."
              : state === "slow"
                ? "Saved, but the shop is taking a while to come back. Reload the page in a minute."
                : "Saving restarts the shop for a few seconds."}
          </span>
          {error ? <span className="text-xs text-danger">{error}</span> : null}
        </div>
      </div>
    </details>
  );
}
