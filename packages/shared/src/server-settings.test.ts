import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  checkSiteAddress,
  isProxyAddress,
  normalizeServerSettings,
  parsePrinterList,
  serverSettingsEnv,
} from "./server-settings";

const printers = new Set(["Prusa MK4 0.4 nozzle", "Bambu Lab A1 0.4 nozzle"]);

describe("checkSiteAddress", () => {
  it("keeps the origin of an https address, adding https:// when left out", () => {
    expect(checkSiteAddress("https://print.example.com/")).toEqual({ ok: true, value: "https://print.example.com" });
    expect(checkSiteAddress("print.example.com")).toEqual({ ok: true, value: "https://print.example.com" });
    expect(checkSiteAddress("")).toEqual({ ok: true, value: "" });
  });

  it("allows plain http only on a private network", () => {
    expect(checkSiteAddress("http://192.168.1.9:8080")).toEqual({ ok: true, value: "http://192.168.1.9:8080" });
    expect(checkSiteAddress("http://print.example.com").ok).toBe(false);
  });

  it("refuses paths, credentials and other schemes", () => {
    for (const bad of ["https://x.com/shop", "https://u:p@x.com", "ftp://x.com", "https://x.com/?a=1", "not a url at all"]) {
      expect(checkSiteAddress(bad).ok, bad).toBe(false);
    }
  });
});

describe("normalizeServerSettings", () => {
  it("is the defaults for anything missing or broken", () => {
    expect(normalizeServerSettings(null)).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(normalizeServerSettings("junk")).toEqual(DEFAULT_SERVER_SETTINGS);
  });

  it("keeps only a printer from the image's list", () => {
    expect(normalizeServerSettings({ printer: { machine: "Prusa MK4 0.4 nozzle", multiMaterial: true } }, printers).printer).toEqual({
      machine: "Prusa MK4 0.4 nozzle",
      multiMaterial: true,
      displayName: "",
    });
    expect(normalizeServerSettings({ printer: { machine: "Made Up 0.4 nozzle", multiMaterial: true } }, printers).printer).toEqual({
      machine: "",
      multiMaterial: false,
      displayName: "",
    });
  });

  it("drops a proxy address that isn't one IP, and anything that could break nginx", () => {
    for (const address of ["10.0.0.0/8", "proxy.lan", "1.2.3.4; deny all", "999.1.1.1"]) {
      expect(normalizeServerSettings({ proxy: { mode: "address", address } }).proxy.mode, address).toBe("none");
    }
    expect(normalizeServerSettings({ proxy: { mode: "address", address: "192.168.1.20", lanAccess: true } }).proxy).toEqual({
      mode: "address",
      address: "192.168.1.20",
      header: "X-Real-IP",
      lanAccess: true,
    });
    expect(isProxyAddress("fd00::1")).toBe(true);
  });

  it("refuses a display name that could carry anything but a name", () => {
    expect(normalizeServerSettings({ printer: { displayName: "Voron 2.4 (300)" } }).printer.displayName).toBe("Voron 2.4 (300)");
    expect(normalizeServerSettings({ printer: { displayName: "x\nTRUSTED_PROXY_CIDR=1.1.1.1" } }).printer.displayName).toBe("");
  });
});

describe("serverSettingsEnv", () => {
  it("is the container's own variables, empty where nothing is set", () => {
    expect(serverSettingsEnv(DEFAULT_SERVER_SETTINGS)).toEqual({
      APP_ORIGIN: "",
      TRUSTED_PROXY_CIDR: "",
      REAL_IP_HEADER: "",
      DIRECT_ACCESS: "",
      PRINTER_MACHINE: "",
      PRINTER_MULTI_MATERIAL: "",
      PRINTER_DISPLAY_NAME: "",
    });
    const s = normalizeServerSettings(
      {
        siteAddress: "https://print.example.com",
        proxy: { mode: "host", header: "CF-Connecting-IP", lanAccess: true },
        printer: { machine: "Bambu Lab A1 0.4 nozzle", multiMaterial: true, displayName: "A1" },
      },
      printers,
    );
    expect(serverSettingsEnv(s)).toEqual({
      APP_ORIGIN: "https://print.example.com",
      TRUSTED_PROXY_CIDR: "host",
      REAL_IP_HEADER: "CF-Connecting-IP",
      DIRECT_ACCESS: "1",
      PRINTER_MACHINE: "Bambu Lab A1 0.4 nozzle",
      PRINTER_MULTI_MATERIAL: "1",
      PRINTER_DISPLAY_NAME: "A1",
    });
  });
});

describe("parsePrinterList", () => {
  it("reads profile-gen's list", () => {
    expect(parsePrinterList("BBL\tBambu Lab A1\tBambu Lab A1 0.4 nozzle\t256x256x256\n\nbroken line\n")).toEqual([
      { vendor: "BBL", model: "Bambu Lab A1", machine: "Bambu Lab A1 0.4 nozzle", bed: "256x256x256" },
    ]);
  });
});
