import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UserAdapter } from "./user-adapter.ts";

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

describe("UserAdapter", () => {
  let agentsDir: string;
  let adapter: UserAdapter;

  beforeEach(async () => {
    agentsDir = join(tmpdir(), `atlas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(agentsDir, { recursive: true });
    adapter = new UserAdapter(agentsDir);
  });

  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
  });

  test("discovers agents from versioned directories with metadata.json", async () => {
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    const agents = await adapter.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "echo-agent",
      type: "user",
      version: "0.1.0",
      description: "An echo agent",
    });
  });

  test("ignores .tmp/ staging directories", async () => {
    const realDir = join(agentsDir, "echo-agent@0.1.0");
    const tmpDir = join(agentsDir, "echo-agent@0.2.0.tmp");
    await mkdir(realDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(join(realDir, "metadata.json"), makeMetadata());
    await writeFile(join(tmpDir, "metadata.json"), makeMetadata({ version: "0.2.0" }));

    const agents = await adapter.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.version).toBe("0.1.0");
  });

  test("returns empty array for empty directory", async () => {
    const agents = await adapter.listAgents();
    expect(agents).toHaveLength(0);
  });

  test("returns empty array when agents directory does not exist", async () => {
    const missingAdapter = new UserAdapter(join(agentsDir, "nonexistent"));
    const agents = await missingAdapter.listAgents();
    expect(agents).toHaveLength(0);
  });

  test("version resolution picks highest semver", async () => {
    const v1Dir = join(agentsDir, "echo-agent@0.1.0");
    const v2Dir = join(agentsDir, "echo-agent@0.2.0");
    await mkdir(v1Dir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v1Dir, "metadata.json"), makeMetadata({ version: "0.1.0" }));
    await writeFile(join(v2Dir, "metadata.json"), makeMetadata({ version: "0.2.0" }));

    const agents = await adapter.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.version).toBe("0.2.0");
  });

  test("exists returns true when agent has version directories", async () => {
    const dir = join(agentsDir, "echo-agent@0.1.0");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), makeMetadata());

    expect(await adapter.exists("echo-agent")).toBe(true);
  });

  test("exists returns false for unknown agent", async () => {
    expect(await adapter.exists("nonexistent")).toBe(false);
  });

  test("loadAgent resolves latest version and returns AgentSourceData", async () => {
    const v1Dir = join(agentsDir, "echo-agent@0.1.0");
    const v2Dir = join(agentsDir, "echo-agent@0.2.0");
    await mkdir(v1Dir, { recursive: true });
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v1Dir, "metadata.json"), makeMetadata({ version: "0.1.0" }));
    await writeFile(join(v2Dir, "metadata.json"), makeMetadata({ version: "0.2.0" }));

    const source = await adapter.loadAgent("echo-agent");
    expect(source).toMatchObject({
      type: "user",
      id: "echo-agent",
      metadata: { sourceLocation: expect.stringContaining("echo-agent@0.2.0"), version: "0.2.0" },
    });
  });

  test("loadAgent throws for nonexistent agent", async () => {
    await expect(adapter.loadAgent("nonexistent")).rejects.toThrow("Agent not found");
  });

  test("adapter properties are correct", () => {
    expect(adapter.adapterName).toBe("user-agent-adapter");
    expect(adapter.sourceType).toBe("user");
  });

  test("discovers multiple different agents", async () => {
    const echoDir = join(agentsDir, "echo-agent@0.1.0");
    const helloDir = join(agentsDir, "hello-agent@1.0.0");
    await mkdir(echoDir, { recursive: true });
    await mkdir(helloDir, { recursive: true });
    await writeFile(join(echoDir, "metadata.json"), makeMetadata());
    await writeFile(
      join(helloDir, "metadata.json"),
      makeMetadata({ id: "hello-agent", version: "1.0.0", description: "A hello agent" }),
    );

    const agents = await adapter.listAgents();
    expect(agents).toHaveLength(2);
    const ids = agents.map((a) => a.id).sort();
    expect(ids).toEqual(["echo-agent", "hello-agent"]);
  });

  test("skips directories without metadata.json", async () => {
    const validDir = join(agentsDir, "echo-agent@0.1.0");
    const invalidDir = join(agentsDir, "broken-agent@0.1.0");
    await mkdir(validDir, { recursive: true });
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(validDir, "metadata.json"), makeMetadata());
    // broken-agent has no metadata.json

    const agents = await adapter.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe("echo-agent");
  });
});
