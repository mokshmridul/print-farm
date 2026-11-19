import { beforeEach, describe, expect, it, vi } from "vitest";

// First run: the shop has no admin password; the visitor who has the setup
// code from the container log creates it. Real admin-auth, mocked database.

const db = vi.hoisted(() => ({
  row: null as { value: unknown } | null,
  findUnique: vi.fn(),
  create: vi.fn(),
}));
const mocks = vi.hoisted(() => ({ createAdminSession: vi.fn(), reserveRateLimit: vi.fn() }));

vi.mock("@print/db", () => ({ prisma: { appSetting: { findUnique: db.findUnique, create: db.create } } }));
vi.mock("@/lib/api-util", () => ({
  guardMutation: async () => null,
  readJsonBody: async (request: Request) => ({ ok: true, value: await request.json() }),
  jsonError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
}));
vi.mock("@/lib/security", () => ({
  RATE_LIMITS: { adminLogin: { max: 5, windowSeconds: 900 }, adminLoginGlobal: { max: 25, windowSeconds: 900 } },
  reserveRateLimit: mocks.reserveRateLimit,
}));
vi.mock("@/lib/session", () => ({ createAdminSession: mocks.createAdminSession }));

vi.stubEnv("SETUP_CODE", "AB12-CD34");
vi.stubEnv("ADMIN_PASSWORD_HASH", "");
const { POST } = await import("@/app/api/admin/claim/route");
const { adminPasswordHash } = await import("@/lib/admin-auth");

const claim = (body: object) =>
  POST(new Request("http://localhost/api/admin/claim", { method: "POST", body: JSON.stringify(body) }) as never);
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

beforeEach(() => {
  vi.clearAllMocks();
  db.row = null;
  db.findUnique.mockImplementation(async () => db.row);
  db.create.mockImplementation(async ({ data }: { data: { value: unknown } }) => {
    if (db.row) throw new Error("unique constraint");
    db.row = { value: data.value };
    return data;
  });
  mocks.reserveRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("POST /api/admin/claim", () => {
  it("creates the admin password with the right code, and signs in", async () => {
    const res = await claim({ code: " ab12-cd34 ", password: "a long admin password" });
    expect(res.status).toBe(200);
    expect(mocks.createAdminSession).toHaveBeenCalledOnce();
    const hash = await adminPasswordHash();
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    const bcrypt = await import("bcryptjs");
    expect(await bcrypt.default.compare("a long admin password", hash!)).toBe(true);
  });

  it("refuses a wrong code, and a short password", async () => {
    expect(await code(await claim({ code: "AB12-CD35", password: "a long admin password" }))).toBe("INVALID_SETUP_CODE");
    expect(await code(await claim({ code: "AB12-CD34", password: "short" }))).toBe("WEAK_PASSWORD");
    expect(db.create).not.toHaveBeenCalled();
    expect(mocks.createAdminSession).not.toHaveBeenCalled();
  });

  it("is closed once a password exists, even with the code", async () => {
    await claim({ code: "AB12-CD34", password: "a long admin password" });
    const again = await claim({ code: "AB12-CD34", password: "someone else's password" });
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("ALREADY_SET_UP");
  });

  it("counts guesses against the shared budget", async () => {
    mocks.reserveRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await claim({ code: "AB12-CD34", password: "a long admin password" })).status).toBe(429);
    expect(db.create).not.toHaveBeenCalled();
  });
});

describe("adminPasswordHash", () => {
  it("is the environment's when set there", async () => {
    vi.stubEnv("ADMIN_PASSWORD_HASH", `$2b$12$${"a".repeat(53)}`);
    expect(await adminPasswordHash()).toBe(`$2b$12$${"a".repeat(53)}`);
    expect(db.findUnique).not.toHaveBeenCalled();
    vi.stubEnv("ADMIN_PASSWORD_HASH", "");
  });
});
