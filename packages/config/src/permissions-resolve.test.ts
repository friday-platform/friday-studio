import { describe, expect, it } from "vitest";
import { resolvePermissions } from "./permissions.ts";

describe("resolvePermissions — precedence", () => {
  it("returns safe default (false) when nothing is set", () => {
    expect(resolvePermissions({})).toEqual({ dangerouslySkipAllowlist: false });
  });

  it("daemon flag flows through when no workspace/job override", () => {
    const r = resolvePermissions({ daemonDangerouslySkipAllowlist: true });
    expect(r.dangerouslySkipAllowlist).toBe(true);
  });

  it("workspace setting overrides daemon", () => {
    const permissive = resolvePermissions({
      workspace: { dangerouslySkipAllowlist: true },
      daemonDangerouslySkipAllowlist: false,
    });
    expect(permissive.dangerouslySkipAllowlist).toBe(true);

    const restrictive = resolvePermissions({
      workspace: { dangerouslySkipAllowlist: false },
      daemonDangerouslySkipAllowlist: true,
    });
    expect(restrictive.dangerouslySkipAllowlist).toBe(false);
  });

  it("job setting overrides workspace", () => {
    const r = resolvePermissions({
      job: { dangerouslySkipAllowlist: false },
      workspace: { dangerouslySkipAllowlist: true },
    });
    expect(r.dangerouslySkipAllowlist).toBe(false);
  });

  it("job overrides daemon (skipping workspace)", () => {
    const r = resolvePermissions({
      job: { dangerouslySkipAllowlist: true },
      daemonDangerouslySkipAllowlist: false,
    });
    expect(r.dangerouslySkipAllowlist).toBe(true);
  });

  it("undefined fields fall through to next layer (not treated as false)", () => {
    // Job has no opinion → workspace wins.
    const r = resolvePermissions({ job: {}, workspace: { dangerouslySkipAllowlist: true } });
    expect(r.dangerouslySkipAllowlist).toBe(true);
  });

  it("explicit false at job level wins over permissive parents", () => {
    // Strict job inside permissive workspace + permissive daemon: job wins.
    const r = resolvePermissions({
      job: { dangerouslySkipAllowlist: false },
      workspace: { dangerouslySkipAllowlist: true },
      daemonDangerouslySkipAllowlist: true,
    });
    expect(r.dangerouslySkipAllowlist).toBe(false);
  });
});
