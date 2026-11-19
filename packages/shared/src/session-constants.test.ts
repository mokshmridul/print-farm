import { describe, expect, it } from "vitest";
import { adminCookieName, isSecureRequest, quoteCookieName } from "./session-constants";

describe("isSecureRequest", () => {
  const https = "https://print.example.com";

  it("is never secure when the shop's origin is plain http", () => {
    expect(isSecureRequest("http://192.168.1.5:8080", "0")).toBe(false);
    expect(isSecureRequest("http://localhost:8080", null)).toBe(false);
    expect(isSecureRequest(undefined, null)).toBe(false);
  });

  it("is secure on an https shop unless nginx marked a direct LAN visit", () => {
    expect(isSecureRequest(https, "0")).toBe(true);
    expect(isSecureRequest(https, null)).toBe(true);
    expect(isSecureRequest(https, "")).toBe(true);
    expect(isSecureRequest(https, "1")).toBe(false);
  });

  it("keeps separate cookie names for the two kinds of visit", () => {
    expect(quoteCookieName(true)).not.toBe(quoteCookieName(false));
    expect(adminCookieName(true)).toMatch(/^__Host-/);
    expect(adminCookieName(false)).not.toMatch(/^__Host-/);
  });
});
