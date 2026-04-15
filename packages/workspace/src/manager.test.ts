/**
 * Tests for workspace manager utilities
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergedConfig } from "@atlas/config";
import { createKVStorage } from "@atlas/storage";
import { aroundEach, describe, expect, it } from "vitest";
import { validateMCPEnvironmentForWorkspace, WorkspaceManager } from "./manager.ts";
import { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

describe("validateMCPEnvironmentForWorkspace", () => {
  const createConfig = (
    servers: Record<string, { env?: Record<string, unknown>; auth?: { token_env: string } }>,
  ): MergedConfig => ({
    atlas: null,
    workspace: {
      version: "1.0",
      workspace: { name: "test" },
      tools: {
        mcp: {
          client_config: { timeout: { progressTimeout: "2m", maxTotalTimeout: "30m" } },
          servers: servers as NonNullable<
            NonNullable<MergedConfig["workspace"]["tools"]>["mcp"]
          >["servers"],
        },
      },
    },
  });

  it("allows Link credential refs in auth.token_env without system env", () => {
    const config = createConfig({
      "google-calendar": {
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: {
            from: "link",
            provider: "google-calendar",
            key: "access_token",
          },
        },
        auth: { token_env: "GOOGLE_CALENDAR_ACCESS_TOKEN" },
      },
    });

    // Should NOT throw - Link provides the token at runtime
    validateMCPEnvironmentForWorkspace(config, "/tmp/nonexistent");
  });

  it("allows literal env values in auth.token_env without system env", () => {
    const config = createConfig({
      "test-server": { env: { MY_TOKEN: "hardcoded-value" }, auth: { token_env: "MY_TOKEN" } },
    });

    // Should NOT throw - literal value is provided in config
    validateMCPEnvironmentForWorkspace(config, "/tmp/nonexistent");
  });

  it("throws when auth.token_env has no env entry and missing from system", () => {
    const config = createConfig({
      "test-server": { env: {}, auth: { token_env: "MISSING_TOKEN" } },
    });

    // Should throw - no env entry and not in system env
    expect(() => validateMCPEnvironmentForWorkspace(config, "/tmp/nonexistent")).toThrow(
      "MISSING_TOKEN",
    );
  });

  it("throws when env value is 'auto' and missing from system", () => {
    const config = createConfig({ "test-server": { env: { AUTO_VAR: "auto" } } });

    // Should throw - "auto" requires system env
    expect(() => validateMCPEnvironmentForWorkspace(config, "/tmp/nonexistent")).toThrow(
      "AUTO_VAR",
    );
  });

  it("throws once (no duplicates) when auth.token_env points to 'auto' value", () => {
    const config = createConfig({
      "test-server": { env: { MY_TOKEN: "auto" }, auth: { token_env: "MY_TOKEN" } },
    });

    // Should throw with MY_TOKEN appearing exactly once (not duplicated)
    try {
      validateMCPEnvironmentForWorkspace(config, "/tmp/nonexistent");
      throw new Error("Expected to throw");
    } catch (e) {
      const message = (e as Error).message;
      // Count occurrences of MY_TOKEN - should be exactly 1
      const matches = message.match(/MY_TOKEN/g) || [];
      if (matches.length !== 1) {
        throw new Error(`Expected MY_TOKEN to appear once, found ${matches.length} times`);
      }
    }
  });

  it("throws once when auth.token_env points to 'from_environment' value", () => {
    const config = createConfig({
      "test-server": { env: { MY_TOKEN: "from_environment" }, auth: { token_env: "MY_TOKEN" } },
    });

    try {
      validateMCPEnvironmentForWorkspace(config, "/tmp/nonexistent");
      throw new Error("Expected to throw");
    } catch (e) {
      const message = (e as Error).message;
      const matches = message.match(/MY_TOKEN/g) || [];
      if (matches.length !== 1) {
        throw new Error(`Expected MY_TOKEN to appear once, found ${matches.length} times`);
      }
    }
  });

  it("passes when no MCP servers configured", () => {
    const config: MergedConfig = {
      atlas: null,
      workspace: { version: "1.0", workspace: { name: "test" } },
    };

    // Should NOT throw - no MCP servers to validate
    validateMCPEnvironmentForWorkspace(config, "/tmp/nonexistent");
  });
});

describe("WorkspaceManager.registerWorkspace — skipEnvValidation", () => {
  // Workspace YAML with a dangling auth.token_env (no env mapping for GH_TOKEN).
  // This is the exact shape produced by importing a workspace whose GitHub
  // credential was stripped because it belonged to a different user.
  const workspaceYaml = `
version: "1.0"
workspace:
  name: test-dangling-token
tools:
  mcp:
    servers:
      github:
        transport:
          type: http
          url: "https://api.githubcopilot.com/mcp"
        auth:
          type: bearer
          token_env: GH_TOKEN
        env: {}
`;

  let tempDir: string;
  let manager: WorkspaceManager;

  aroundEach(async (run) => {
    tempDir = await mkdtemp(join(tmpdir(), "atlas-test-"));
    await writeFile(join(tempDir, "workspace.yml"), workspaceYaml);

    const kv = await createKVStorage({ type: "memory" });
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();
    manager = new WorkspaceManager(registry);
    await run();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("throws on dangling auth.token_env without skipEnvValidation", async () => {
    await expect(manager.registerWorkspace(tempDir)).rejects.toThrow("GH_TOKEN");
  });

  it("succeeds with skipEnvValidation: true despite dangling auth.token_env", async () => {
    const { workspace, created } = await manager.registerWorkspace(tempDir, {
      skipEnvValidation: true,
    });

    expect(created).toBe(true);
    expect(workspace.name).toBe("test-dangling-token");
  });
});

describe("WorkspaceManager.registerWorkspace — options.id", () => {
  const workspaceYaml = `
version: "1.0"
workspace:
  name: custom-id-test
`;

  let tempDir: string;
  let manager: WorkspaceManager;

  aroundEach(async (run) => {
    tempDir = await mkdtemp(join(tmpdir(), "atlas-test-id-"));
    await writeFile(join(tempDir, "workspace.yml"), workspaceYaml);

    const kv = await createKVStorage({ type: "memory" });
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();
    manager = new WorkspaceManager(registry);
    await run();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses the provided ID instead of generating one", async () => {
    const { workspace, created } = await manager.registerWorkspace(tempDir, { id: "custom-id" });

    expect(created).toBe(true);
    expect(workspace.id).toBe("custom-id");
    expect(workspace.name).toBe("custom-id-test");
  });

  it("returns existing workspace when id already exists in registry", async () => {
    const first = await manager.registerWorkspace(tempDir, { id: "custom-id" });
    expect(first.created).toBe(true);

    const second = await manager.registerWorkspace(tempDir, { id: "custom-id" });
    expect(second.created).toBe(false);
    expect(second.workspace.id).toBe("custom-id");
  });
});
