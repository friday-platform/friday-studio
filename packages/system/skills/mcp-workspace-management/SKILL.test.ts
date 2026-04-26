import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillMd } from "@atlas/skills";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSkillMd(): Promise<string> {
  return readFile(join(__dirname, "SKILL.md"), "utf-8");
}

describe("mcp-workspace-management SKILL.md", () => {
  it("has valid frontmatter with correct name and description", async () => {
    const content = await loadSkillMd();
    const result = parseSkillMd(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.frontmatter.name).toBe("mcp-workspace-management");
    expect(result.data.frontmatter.description).toContain(
      "MCP server catalog vs workspace-scoped enablement",
    );
    expect(result.data.frontmatter["user-invocable"]).toBe(false);
  });

  it("teaches the four-action model", async () => {
    const content = await loadSkillMd();
    const lower = content.toLowerCase();

    // Global catalog actions
    expect(lower).toContain("search_mcp_servers");
    expect(lower).toContain("install_mcp_server");

    // Workspace-scoped actions
    expect(lower).toContain("enable_mcp_server");
    expect(lower).toContain("disable_mcp_server");

    // Delete / catalog scope
    expect(lower).toContain("delete_mcp_server");

    // Scope distinctions
    expect(lower).toContain("global catalog");
    expect(lower).toContain("workspace");
  });

  it("explains when to use enable vs install", async () => {
    const content = await loadSkillMd();
    expect(content).toContain("enable_mcp_server(X)");
    expect(content).toContain("install_mcp_server");
    expect(content).toContain("If X is already in the catalog");
    expect(content).toContain("If X is NOT in the catalog");
  });

  it("mentions the force confirmation pattern", async () => {
    const content = await loadSkillMd();
    expect(content).toContain("force: true");
    expect(content).toContain("willUnlinkFrom");
    expect(content).toContain("ask the user to confirm");
  });

  it("explains reference safety for disable", async () => {
    const content = await loadSkillMd();
    const lower = content.toLowerCase();
    expect(lower).toContain("agents");
    expect(lower).toContain("jobs");
    expect(lower).toContain("409");
    expect(content).toContain("config.agents.{id}.config.tools");
    expect(content).toContain("config.jobs.{id}.fsm.states[].entry[].tools");
  });

  it("covers custom servers", async () => {
    const content = await loadSkillMd();
    expect(content).toContain('source: "workspace"');
    expect(content).toContain("manual YAML editing");
  });

  it("mentions blueprint workspace handling", async () => {
    const content = await loadSkillMd();
    expect(content).toContain("Blueprint workspaces");
    expect(content).toContain("422");
  });

  it("mentions the get_workspace_mcp_status tool", async () => {
    const content = await loadSkillMd();
    expect(content).toContain("get_workspace_mcp_status");
  });

  it("describes the idempotent enable behavior", async () => {
    const content = await loadSkillMd();
    expect(content).toContain("Idempotent");
    expect(content).toContain("calling it again succeeds with no mutation");
  });
});
