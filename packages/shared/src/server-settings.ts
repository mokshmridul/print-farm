/**
 * Server settings: what the container itself needs to know — the shop's web
 * address, which reverse proxy to trust, and the printer picked from
 * OrcaSlicer's list. The owner sets them in the browser (first-run tour,
 * admin → Settings → Server); they live in one file in the data folder,
 * `config/settings.json`, which the container applies (regenerating printer
 * profiles, re-rendering nginx, restarting web and worker) whenever it
 * changes. An environment variable of the same meaning still wins, as with
 * any image.
 *
 * Zod-free and dependency-free: the container's root-side reader is bundled
 * from this file too, and validates everything again before using it — the
 * file is written by the unprivileged web.
 */

// The WHATWG URL global (Node and browsers alike); this package is built
// without DOM or Node types, so declare the part used here.
declare const URL: new (input: string) => {
  protocol: string;
  username: string;
  password: string;
  search: string;
  hash: string;
  pathname: string;
  hostname: string;
  origin: string;
};

export type ProxyMode = "none" | "host" | "address";
export type RealIpHeader = "X-Real-IP" | "CF-Connecting-IP";

export interface ServerSettings {
  /** Public origin, e.g. https://print.example.com. "" = not set yet. */
  siteAddress: string;
  proxy: {
    /** none: visitors connect directly. host: a reverse proxy on this same
     *  computer (it reaches the container through its network gateway).
     *  address: a reverse proxy at `address`. */
    mode: ProxyMode;
    address: string;
    header: RealIpHeader;
    /** With a proxy set, still serve devices that connect directly (the LAN). */
    lanAccess: boolean;
  };
  printer: {
    /** An exact OrcaSlicer machine preset from the image's list. "" = the
     *  owner uploads their own printer preset instead. */
    machine: string;
    multiMaterial: boolean;
    /** Name customers see; "" = the printer's own. */
    displayName: string;
  };
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  siteAddress: "",
  proxy: { mode: "none", address: "", header: "X-Real-IP", lanAccess: false },
  printer: { machine: "", multiMaterial: false, displayName: "" },
};

/** The environment variable that overrides each setting. */
export const SERVER_SETTING_ENV = {
  siteAddress: "APP_ORIGIN",
  proxy: "TRUSTED_PROXY_CIDR",
  printer: "PRINTER_MACHINE",
} as const;

const PRIVATE_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
  const m = PRIVATE_V4.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** A web address as the shop stores it (its origin), or an error to show. */
export function checkSiteAddress(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: "" };
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, error: "That isn't a web address, e.g. https://print.example.com." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Use an http:// or https:// address." };
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, error: "Just the address, with no path: https://print.example.com." };
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    return { ok: false, error: "An address reachable from the internet must use https:// (put it behind a reverse proxy with HTTPS)." };
  }
  return { ok: true, value: url.origin };
}

/** One IPv4 or IPv6 host, as nginx's set_real_ip_from takes it. */
export function isProxyAddress(value: string): boolean {
  const v4 = PRIVATE_V4.exec(value);
  if (v4) return v4.slice(1).every((n) => Number(n) <= 255);
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":") && value.length <= 39;
}

const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+/()-]{0,59}$/;
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9 ._+/()&@-]{0,99}$/;

/** Harden a stored or submitted value field by field; anything invalid falls
 *  back to its default. `printers` (the image's list) checks the machine. */
export function normalizeServerSettings(raw: unknown, printers?: ReadonlySet<string>): ServerSettings {
  const d = DEFAULT_SERVER_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const p = (r.proxy && typeof r.proxy === "object" ? r.proxy : {}) as Record<string, unknown>;
  const pr = (r.printer && typeof r.printer === "object" ? r.printer : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const site = checkSiteAddress(str(r.siteAddress));
  const mode: ProxyMode = p.mode === "host" || p.mode === "address" ? p.mode : "none";
  const address = str(p.address);
  const header: RealIpHeader = p.header === "CF-Connecting-IP" ? "CF-Connecting-IP" : "X-Real-IP";
  const machine = str(pr.machine);
  const machineOk = machine !== "" && MACHINE.test(machine) && (!printers || printers.has(machine));
  const displayName = str(pr.displayName);

  const proxyMode: ProxyMode = mode === "address" && !isProxyAddress(address) ? "none" : mode;
  return {
    siteAddress: site.ok ? site.value : d.siteAddress,
    proxy: {
      mode: proxyMode,
      address: proxyMode === "address" ? address : "",
      header,
      lanAccess: proxyMode !== "none" && p.lanAccess === true,
    },
    printer: {
      machine: machineOk ? machine : "",
      multiMaterial: machineOk && pr.multiMaterial === true,
      displayName: DISPLAY_NAME.test(displayName) ? displayName : "",
    },
  };
}

/** The settings as the container's own variables (what an environment
 *  variable of the same name would override). Values never hold a newline. */
export function serverSettingsEnv(s: ServerSettings): Record<string, string> {
  return {
    APP_ORIGIN: s.siteAddress,
    TRUSTED_PROXY_CIDR: s.proxy.mode === "host" ? "host" : s.proxy.mode === "address" ? s.proxy.address : "",
    REAL_IP_HEADER: s.proxy.mode === "none" ? "" : s.proxy.header,
    DIRECT_ACCESS: s.proxy.mode !== "none" && s.proxy.lanAccess ? "1" : "",
    PRINTER_MACHINE: s.printer.machine,
    PRINTER_MULTI_MATERIAL: s.printer.machine && s.printer.multiMaterial ? "1" : "",
    PRINTER_DISPLAY_NAME: s.printer.displayName,
  };
}

/** The image's printer list (`profile-gen list`: vendor, model, machine preset,
 *  build volume — tab-separated), parsed. */
export interface PrinterChoice {
  vendor: string;
  model: string;
  machine: string;
  bed: string;
}

export function parsePrinterList(text: string): PrinterChoice[] {
  return text
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 4 && cols[2])
    .map(([vendor, model, machine, bed]) => ({ vendor: vendor!, model: model!, machine: machine!, bed: bed! }));
}
