import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  setting: vi.fn(async (): Promise<unknown> => null),
  quotation: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("@print/db", () => ({
  prisma: {
    appSetting: { findUnique: db.setting },
    quotation: { findFirst: db.quotation },
  },
}));

const { shouldOfferSetup } = await import("@/lib/setup-wizard");

beforeEach(() => {
  db.setting.mockResolvedValue(null);
  db.quotation.mockResolvedValue(null);
});

describe("shouldOfferSetup", () => {
  it("opens the tour on a new shop's first admin visit, whatever its printer mode", async () => {
    vi.stubEnv("ADVANCED_PROFILES", "0");
    expect(await shouldOfferSetup()).toBe(true);
    vi.stubEnv("ADVANCED_PROFILES", "1");
    expect(await shouldOfferSetup()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("not once it's been finished or skipped", async () => {
    db.setting.mockResolvedValue({ key: "setupWizard" });
    expect(await shouldOfferSetup()).toBe(false);
  });

  it("not on a shop that already takes quotations", async () => {
    db.quotation.mockResolvedValue({ id: "q1" });
    expect(await shouldOfferSetup()).toBe(false);
  });
});
