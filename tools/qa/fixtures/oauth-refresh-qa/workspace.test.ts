import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceConfigSchema } from "@atlas/config";
import { parse as parseYaml } from "@std/yaml";
import { describe, expect, it } from "vitest";

const workspaceYmlPath = fileURLToPath(new URL("./workspace.yml", import.meta.url));

describe("oauth-refresh-qa fixture", () => {
  const raw = parseYaml(readFileSync(workspaceYmlPath, "utf-8"));
  const result = WorkspaceConfigSchema.safeParse(raw);

  it("parses through WorkspaceConfigSchema without errors", () => {
    if (!result.success) {
      throw new Error(`workspace.yml failed to parse:\n${result.error.message}`);
    }
    expect(result.success).toBe(true);
  });

  it("declares the surface the QA scenarios depend on", () => {
    if (!result.success) throw new Error("parse failed (see prior test)");
    const cfg = result.data;

    expect(cfg.workspace.id).toBe("oauth-refresh-qa");
    expect(cfg.tools?.mcp?.servers).toMatchObject({
      "google-calendar": expect.any(Object),
      "google-gmail": expect.any(Object),
    });
    expect(cfg.agents?.["workspace-chat"]).toMatchObject({
      type: "system",
      agent: "workspace-chat",
    });
    expect(cfg.signals?.["every-minute"]).toMatchObject({ provider: "schedule" });
    expect(cfg.signals?.["refresh-webhook"]).toMatchObject({ provider: "http" });
    expect(cfg.jobs?.["calendar-cron-check"]).toBeDefined();
    expect(cfg.jobs?.["gmail-webhook-check"]).toBeDefined();
  });
});
