import { describe, expect, it } from "vitest";
import { isBlockedIP, isBlockedIPv4, isBlockedIPv6, assertPublicHost } from "./web-fetch.ts";

// ---------------------------------------------------------------------------
// SSRF guard — isBlockedIPv4
// ---------------------------------------------------------------------------

describe("isBlockedIPv4", () => {
  it("blocks RFC1918 private ranges", () => {
    expect(isBlockedIPv4("10.0.0.1")).toBe(true);
    expect(isBlockedIPv4("172.16.0.1")).toBe(true);
    expect(isBlockedIPv4("192.168.1.1")).toBe(true);
  });

  it("blocks loopback", () => {
    expect(isBlockedIPv4("127.0.0.1")).toBe(true);
    expect(isBlockedIPv4("127.255.255.255")).toBe(true);
  });

  it("blocks link-local (including cloud metadata)", () => {
    expect(isBlockedIPv4("169.254.169.254")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isBlockedIPv4("8.8.8.8")).toBe(false);
    expect(isBlockedIPv4("1.1.1.1")).toBe(false);
    expect(isBlockedIPv4("140.82.121.4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — isBlockedIPv6
// ---------------------------------------------------------------------------

describe("isBlockedIPv6", () => {
  it("blocks loopback", () => {
    expect(isBlockedIPv6("::1")).toBe(true);
  });

  it("blocks link-local", () => {
    expect(isBlockedIPv6("fe80::1")).toBe(true);
  });

  it("blocks unique-local", () => {
    expect(isBlockedIPv6("fc00::1")).toBe(true);
    expect(isBlockedIPv6("fd00::1")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isBlockedIPv6("2001:4860:4860::8888")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — isBlockedIP (dispatcher)
// ---------------------------------------------------------------------------

describe("isBlockedIP", () => {
  it("blocks invalid / non-IP strings", () => {
    expect(isBlockedIP("not-an-ip")).toBe(true);
  });

  it("blocks IPv4 loopback", () => {
    expect(isBlockedIP("127.0.0.1")).toBe(true);
  });

  it("blocks IPv6 loopback", () => {
    expect(isBlockedIP("::1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF guard — assertPublicHost (hostname resolution)
// ---------------------------------------------------------------------------

describe("assertPublicHost", () => {
  it("allows localhost", async () => {
    await expect(assertPublicHost("localhost")).resolves.toBeUndefined();
  });

  it("allows 127.0.0.1", async () => {
    await expect(assertPublicHost("127.0.0.1")).resolves.toBeUndefined();
  });

  it("allows ::1", async () => {
    await expect(assertPublicHost("::1")).resolves.toBeUndefined();
  });

  it("blocks literal private IPv4", async () => {
    await expect(assertPublicHost("10.0.0.1")).rejects.toThrow("Blocked");
  });

  it("blocks literal loopback IPv4 (when not 127.0.0.1)", async () => {
    await expect(assertPublicHost("127.0.1.1")).rejects.toThrow("Blocked");
  });

  it("blocks literal link-local IPv4", async () => {
    await expect(assertPublicHost("169.254.169.254")).rejects.toThrow("Blocked");
  });
});
