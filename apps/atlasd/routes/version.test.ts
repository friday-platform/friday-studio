import { describe, expect, it } from "vitest";
import { z } from "zod";
import { versionRoutes } from "./version.ts";

const VersionResponseSchema = z.object({
  version: z.string(),
  isCompiled: z.boolean(),
  isNightly: z.boolean(),
  isDev: z.boolean(),
  gitSha: z.string().optional(),
});

describe("daemon /api/version", () => {
  it("returns 200 with the getVersionInfo() shape", async () => {
    const res = await versionRoutes.request("http://127.0.0.1:8080/", { method: "GET" });

    expect(res.status).toBe(200);
    VersionResponseSchema.parse(await res.json());
  });
});
