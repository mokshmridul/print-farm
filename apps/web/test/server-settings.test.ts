import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "server-settings-"));
const file = join(dir, "settings.json");
const printers = join(dir, "printers.tsv");
writeFileSync(printers, "Prusa\tPrusa MK4\tPrusa MK4 0.4 nozzle\t250x210x220\nBBL\tBambu Lab A1\tBambu Lab A1 0.4 nozzle\t256x256x256\n");
vi.stubEnv("SERVER_SETTINGS_FILE", file);
vi.stubEnv("PRINTERS_FILE", printers);

const { ServerSettingsRejected, printerChoices, saveServerSettings, serverSettingsView } = await import("@/lib/server-settings");

beforeEach(() => {
  if (existsSync(file)) unlinkSync(file);
  vi.stubEnv("SERVER_SETTINGS_LOCKED", "");
});

describe("server settings", () => {
  it("lists the image's printers", () => {
    expect(printerChoices().map((p) => p.machine)).toEqual(["Prusa MK4 0.4 nozzle", "Bambu Lab A1 0.4 nozzle"]);
  });

  it("saves a change to the file, owner-only, keeping the rest", async () => {
    await saveServerSettings({ siteAddress: "print.example.com" });
    await saveServerSettings({ printer: { machine: "Bambu Lab A1 0.4 nozzle", multiMaterial: true } });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ siteAddress: "https://print.example.com", printer: { machine: "Bambu Lab A1 0.4 nozzle", multiMaterial: true } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(serverSettingsView().settings.siteAddress).toBe("https://print.example.com");
  });

  it("refuses what wouldn't apply, saying why, and changes nothing", async () => {
    await expect(saveServerSettings({ siteAddress: "http://print.example.com" })).rejects.toThrow(/https/);
    await expect(saveServerSettings({ proxy: { mode: "address", address: "proxy.lan" } })).rejects.toThrow(/IP address/);
    await expect(saveServerSettings({ printer: { machine: "Made Up 0.4 nozzle" } })).rejects.toThrow(ServerSettingsRejected);
    expect(existsSync(file)).toBe(false);
  });

  it("never changes what the container's environment sets", async () => {
    vi.stubEnv("SERVER_SETTINGS_LOCKED", "APP_ORIGIN");
    expect(serverSettingsView().locked).toEqual({ siteAddress: true, proxy: false, printer: false });
    await expect(saveServerSettings({ siteAddress: "https://other.example.com" })).rejects.toThrow(/environment/);
    await saveServerSettings({ proxy: { mode: "host", header: "CF-Connecting-IP" } });
    expect(serverSettingsView().settings.proxy).toMatchObject({ mode: "host", header: "CF-Connecting-IP" });
  });

  it("reads a broken file as the defaults", () => {
    writeFileSync(file, "{oops");
    expect(serverSettingsView().settings.siteAddress).toBe("");
  });
});
