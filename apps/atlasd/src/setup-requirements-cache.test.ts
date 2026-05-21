import { WorkspaceConfigSchema } from "@atlas/config";
import type { SetupRequirementsResult } from "@atlas/workspace";
import { describe, expect, it, vi } from "vitest";
import { getOrComputeSetupRequirements } from "./setup-requirements-cache.ts";

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    get: <K extends string>(key: K) => store.get(key) as never,
    set: <K extends string>(key: K, value: unknown) => {
      store.set(key, value);
    },
  };
}

function inputs(provider: string) {
  return Promise.resolve({
    parsedConfig: WorkspaceConfigSchema.parse({
      version: "1.0",
      workspace: { name: "test", id: "test", description: "test workspace" },
      tools: {
        mcp: {
          servers: {
            myserver: {
              transport: { type: "stdio", command: "npx", args: ["-y", "some-server"] },
              env: { TOKEN: { from: "link", provider, key: "access_token" } },
            },
          },
        },
      },
    }),
    envSnapshot: {},
    linkCredentials: {
      defaultByProvider: { [provider]: null },
      resolvedIds: new Set<string>(),
      providerErrors: new Set<string>(),
    },
    options: { allowStaleIdRecovery: true as const },
  });
}

describe("getOrComputeSetupRequirements per-request memoization", () => {
  it("invokes compute() once per (request, workspace) pair", async () => {
    const ctx = makeCtx();
    const compute = vi.fn(() => inputs("github"));

    const first: SetupRequirementsResult = await getOrComputeSetupRequirements(
      ctx,
      "ws-1",
      compute,
    );
    const second: SetupRequirementsResult = await getOrComputeSetupRequirements(
      ctx,
      "ws-1",
      compute,
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.requires_setup).toBe(true);
  });

  it("computes separately for distinct workspace ids within the same request", async () => {
    const ctx = makeCtx();
    const compute = vi.fn(() => inputs("github"));

    await getOrComputeSetupRequirements(ctx, "ws-1", compute);
    await getOrComputeSetupRequirements(ctx, "ws-2", compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("a fresh context (new request) re-computes", async () => {
    const compute1 = vi.fn(() => inputs("github"));
    const compute2 = vi.fn(() => inputs("github"));

    await getOrComputeSetupRequirements(makeCtx(), "ws-1", compute1);
    await getOrComputeSetupRequirements(makeCtx(), "ws-1", compute2);

    expect(compute1).toHaveBeenCalledTimes(1);
    expect(compute2).toHaveBeenCalledTimes(1);
  });
});
