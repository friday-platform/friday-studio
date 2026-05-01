import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentRegistry } from "./registry.ts";

/** Create a minimal valid metadata.json for testing */
function makeMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "echo-agent",
    version: "0.1.0",
    description: "An echo agent",
    expertise: { examples: ["echo hello"] },
    ...overrides,
  });
}

describe("AgentRegistry with UserAdapter", () => {
  let agentsDir: string;

  beforeEach(async () => {
    agentsDir = join(
      tmpdir(),
      `atlas-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
  });

  test("listAgents includes user agents alongside bundled agents", async () => {
    // Write a user agent to disk
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    const registry = new AgentRegistry({ userAgentsDir: agentsDir });
    const agents = await registry.listAgents();

    // Should include bundled agents + our user agent
    const userAgent = agents.find((a) => a.id === "echo-agent");
    expect(userAgent).toBeDefined();
    expect(userAgent?.description).toBe("An echo agent");
    expect(userAgent?.version).toBe("0.1.0");

    // Bundled agents should still be present
    const bundledCount = agents.filter((a) => a.id !== "echo-agent").length;
    expect(bundledCount).toBeGreaterThan(0);
  });

  test("exists returns true for user agents", async () => {
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    const registry = new AgentRegistry({ userAgentsDir: agentsDir });
    await registry.initialize();
    expect(await registry.exists("echo-agent")).toBe(true);
  });

  test("getAgentSourceType returns 'user' for user agents", async () => {
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    const registry = new AgentRegistry({ userAgentsDir: agentsDir });
    await registry.initialize();
    expect(registry.getAgentSourceType("echo-agent")).toBe("user");
  });

  test("getUserAgentSummary returns summary for user agents", async () => {
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    const registry = new AgentRegistry({ userAgentsDir: agentsDir });
    await registry.initialize();

    const summary = registry.getUserAgentSummary("echo-agent");
    expect(summary).toBeDefined();
    expect(summary?.id).toBe("echo-agent");
    expect(summary?.type).toBe("user");
  });

  test("getStats includes user agent count", async () => {
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    const registry = new AgentRegistry({ userAgentsDir: agentsDir });
    await registry.initialize();

    const stats = registry.getStats();
    expect(stats.userAgents).toBe(1);
    expect(stats.bundledAgents).toBeGreaterThan(0);
    expect(stats.totalAgents).toBe(
      stats.bundledAgents + stats.userAgents + stats.sdkAgents + stats.systemAgents,
    );
  });

  test("reload picks up newly built agents", async () => {
    const registry = new AgentRegistry({ userAgentsDir: agentsDir });
    await registry.initialize();

    // No user agents initially
    expect(registry.getStats().userAgents).toBe(0);

    // Simulate `atlas agent build` writing artifacts
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    // After reload, agent should appear
    await registry.reload();
    expect(registry.getStats().userAgents).toBe(1);
    expect(await registry.exists("echo-agent")).toBe(true);
  });

  test("adapter order: system → bundled → user → SDK", () => {
    const registry = new AgentRegistry({ includeSystemAgents: true, userAgentsDir: agentsDir });

    // Access the loader's adapter list through the public interface
    // Verify order by checking adapter names
    const loader = (
      registry as unknown as { loader: { getAdapters(): Array<{ adapterName: string }> } }
    ).loader;
    const names = loader.getAdapters().map((a) => a.adapterName);

    expect(names).toEqual([
      "system-agent-adapter",
      "bundled-agent-adapter",
      "user-agent-adapter",
      "sdk-agent-adapter",
    ]);
  });

  test("works without userAgentsDir (no user adapter registered)", () => {
    const registry = new AgentRegistry();
    const loader = (
      registry as unknown as { loader: { getAdapters(): Array<{ adapterName: string }> } }
    ).loader;
    const names = loader.getAdapters().map((a) => a.adapterName);

    expect(names).not.toContain("user-agent-adapter");
  });
});
