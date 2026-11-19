import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSettings } from "./read-settings";

const dir = mkdtempSync(join(tmpdir(), "read-settings-"));
const list = join(dir, "printers.tsv");
writeFileSync(list, "Prusa\tPrusa MK4\tPrusa MK4 0.4 nozzle\t250x210x220\n");
const file = join(dir, "settings.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("readSettings (the container's root-side reader)", () => {
  it("is all empty without a settings file", () => {
    expect(Object.values(readSettings(join(dir, "missing.json"), list)).every((v) => v === "")).toBe(true);
  });

  it("validates what the web wrote, the printer against the image's list", () => {
    writeFileSync(file, JSON.stringify({ siteAddress: "https://print.example.com", printer: { machine: "Prusa MK4 0.4 nozzle" } }));
    expect(readSettings(file, list)).toMatchObject({ APP_ORIGIN: "https://print.example.com", PRINTER_MACHINE: "Prusa MK4 0.4 nozzle" });
    writeFileSync(file, JSON.stringify({ siteAddress: "http://evil.example.com", printer: { machine: "../../etc 0.4 nozzle" } }));
    expect(readSettings(file, list)).toMatchObject({ APP_ORIGIN: "", PRINTER_MACHINE: "" });
  });

  it("refuses a file that isn't JSON, and one that's oversized", () => {
    writeFileSync(file, "{nope");
    expect(() => readSettings(file, list)).toThrow();
    writeFileSync(file, " ".repeat(70 * 1024));
    expect(() => readSettings(file, list)).toThrow(/larger than/);
  });
});
