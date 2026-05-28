import { describe, expect, it } from "vitest";
import { z } from "zod";
import { versionRoutes } from "./version.ts";

// No production VersionResponse schema/type is exported from @atlas/utils —
// `getVersionInfo()` returns an inferred shape. These assertions ARE the
// contract for the daemon's /api/version payload. The `version` field is
// load-bearing: the launcher's getDaemonVersion keys off it (export.go).
const VersionResponseSchema = z.object({
  version: z.string(),
  isCompiled: z.boolean(),
  isNightly: z.boolean(),
  isDev: z.boolean(),
  gitSha: z.string().optional(),
});

describe("daemon /api/version", () => {
  // The auth contract (401 in non-dev, auto-mint in dev) belongs to the
  // shared `/api/*` session middleware and is covered against real storage
  // in apps/atlasd/src/session-middleware.test.ts — nothing about it is
  // version-route-specific, so it is not re-tested here.
  it("returns the from-source build version info", async () => {
    const res = await versionRoutes.request("http://127.0.0.1:8080/", { method: "GET" });

    expect(res.status).toBe(200);
    const body = VersionResponseSchema.parse(await res.json());

    // Tests run from a git checkout, never a compiled binary.
    expect(body.isCompiled).toBe(false);
    expect(body.isNightly).toBe(false);
    expect(body.isDev).toBe(true);

    // Source builds report `dev-<short-sha>` (or bare `dev` without git).
    expect(body.version).toMatch(/^dev(-[0-9a-f]+)?$/);

    // gitSha mirrors the version's sha suffix — the launcher relies on
    // version being the authoritative field, so the two cannot drift.
    expect(body.gitSha).toBe(body.version.replace("dev-", ""));
  });
});
