/**
 * Tests for workspace manager utilities
 */

import type { MergedConfig } from "@atlas/config";
import { describe, expect, it } from "vitest";
import { validateMCPEnvironmentForWorkspace } from "./manager.ts";

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
