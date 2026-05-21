/**
 * Tests for the centralized setup-state assembly helper.
 *
 * The helper is pure consolidation — `buildSetupRequirementInputs` runs
 * `loadWorkspaceEnv + assembleLinkCredentialState`, and `getWorkspaceSetupState`
 * adds the manager-driven config load + the `resolveWorkspaceSetupRequirements`
 * call. The matrix of "what does the derivation produce for input X" is owned
 * by `@atlas/workspace`'s own tests; here we only pin:
 *
 *  1. The helper composes the trio in the right order with the right args.
 *  2. Errors from `assembleLinkCredentialState` (e.g. ones the assembler
 *     deliberately didn't swallow) propagate verbatim — the wrapper adds no
 *     fail-closed / fail-open policy of its own.
 *  3. `getWorkspaceSetupState` returns `null` (no derivation) when the
 *     workspace entry or its config is missing.
 */

import { type WorkspaceConfig, WorkspaceConfigSchema } from "@atlas/config";
import type { LinkCredentialState, WorkspaceManager } from "@atlas/workspace";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockAssembleLinkState, mockLoadEnv } = vi.hoisted(() => ({
  mockAssembleLinkState: vi.fn(),
  mockLoadEnv: vi.fn(),
}));

vi.mock("./assemble-link-credential-state.ts", () => ({
  assembleLinkCredentialState: mockAssembleLinkState,
}));
vi.mock("@atlas/workspace", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atlas/workspace")>();
  return { ...original, loadWorkspaceEnv: mockLoadEnv };
});

import {
  buildSetupRequirementInputs,
  getWorkspaceSetupState,
} from "./get-workspace-setup-state.ts";

const EMPTY_LINK_STATE: LinkCredentialState = {
  defaultByProvider: {},
  resolvedIds: new Set<string>(),
  providerErrors: new Set<string>(),
};

function parseConfig(input: unknown): WorkspaceConfig {
  return WorkspaceConfigSchema.parse(input);
}

function configWithUnfilledVariable(): WorkspaceConfig {
  return parseConfig({
    version: "1.0",
    workspace: { name: "Test" },
    variables: { region: { description: "AWS region", schema: { type: "string" } } },
  });
}

function configWithNoRequirements(): WorkspaceConfig {
  return parseConfig({ version: "1.0", workspace: { name: "Test" } });
}

describe("buildSetupRequirementInputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadEnv.mockReturnValue({});
    mockAssembleLinkState.mockResolvedValue(EMPTY_LINK_STATE);
  });

  test("composes loadWorkspaceEnv + assembleLinkCredentialState with the right args", async () => {
    const config = configWithNoRequirements();
    mockLoadEnv.mockReturnValueOnce({ FOO: "bar" });
    const linkState: LinkCredentialState = {
      defaultByProvider: { gmail: "cred-abc" },
      resolvedIds: new Set(["cred-1"]),
      providerErrors: new Set<string>(),
    };
    mockAssembleLinkState.mockResolvedValueOnce(linkState);

    const result = await buildSetupRequirementInputs("/tmp/ws-1", config);

    expect(mockLoadEnv).toHaveBeenCalledExactlyOnceWith("/tmp/ws-1");
    expect(mockAssembleLinkState).toHaveBeenCalledExactlyOnceWith(config);
    expect(result).toEqual({ envSnapshot: { FOO: "bar" }, linkCredentials: linkState });
  });

  test("errors from assembleLinkCredentialState propagate verbatim (no swallow)", async () => {
    // The assembler owns the Link fail-open policy (Decision 3 — transient
    // errors get masked back into `resolvedIds`). The wrapper must not add a
    // second layer of fail-closed/open handling on top, or callers lose the
    // ability to reason about Link error semantics from one place.
    const boom = new Error("assembler exploded");
    mockAssembleLinkState.mockRejectedValueOnce(boom);

    await expect(buildSetupRequirementInputs("/tmp/ws-1", configWithNoRequirements())).rejects.toBe(
      boom,
    );
  });
});

describe("getWorkspaceSetupState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadEnv.mockReturnValue({});
    mockAssembleLinkState.mockResolvedValue(EMPTY_LINK_STATE);
  });

  function makeManager(args: {
    workspace: { id: string; path: string } | null;
    config: { workspace: WorkspaceConfig } | null;
  }): WorkspaceManager {
    return {
      find: vi.fn().mockResolvedValue(args.workspace),
      getWorkspaceConfig: vi.fn().mockResolvedValue(args.config),
    } as unknown as WorkspaceManager;
  }

  test("returns null when the workspace entry is missing", async () => {
    const manager = makeManager({ workspace: null, config: null });

    const result = await getWorkspaceSetupState("ws-missing", manager, {
      allowStaleIdRecovery: true,
    });

    expect(result).toBeNull();
    expect(mockLoadEnv).not.toHaveBeenCalled();
    expect(mockAssembleLinkState).not.toHaveBeenCalled();
  });

  test("returns null when the workspace config is missing", async () => {
    const manager = makeManager({
      workspace: { id: "ws-1", path: "/tmp/ws-1" },
      config: null,
    });

    const result = await getWorkspaceSetupState("ws-1", manager, { allowStaleIdRecovery: true });

    expect(result).toBeNull();
    expect(mockLoadEnv).not.toHaveBeenCalled();
  });

  test("returns the resolveWorkspaceSetupRequirements result verbatim", async () => {
    // An unfilled declared variable trips `requires_setup: true` regardless
    // of the Link snapshot — proves the wrapper hands the parsed config
    // (not a wrapper-fabricated shim) into the pure derivation.
    const config = configWithUnfilledVariable();
    const manager = makeManager({
      workspace: { id: "ws-1", path: "/tmp/ws-1" },
      config: { workspace: config },
    });

    const result = await getWorkspaceSetupState("ws-1", manager, { allowStaleIdRecovery: true });

    expect(result).toEqual({
      requires_setup: true,
      setup_requirements: [
        { kind: "variable", name: "region", description: "AWS region", schema: { type: "string" } },
      ],
    });
    expect(mockLoadEnv).toHaveBeenCalledExactlyOnceWith("/tmp/ws-1");
    expect(mockAssembleLinkState).toHaveBeenCalledExactlyOnceWith(config);
  });

  test("threads allowStaleIdRecovery through to the derivation", async () => {
    // The two import-vs-read code paths flip this flag; the wrapper must not
    // pin a default. A pinned credential id that is NOT in resolvedIds with
    // `allowStaleIdRecovery: false` throws `StaleCredentialIdAtImportError`;
    // with `true` it surfaces as a `stale_id` requirement instead.
    const config = parseConfig({
      version: "1.0",
      workspace: { name: "Test" },
      tools: {
        mcp: {
          servers: {
            gmail: {
              transport: { type: "stdio", command: "npx", args: ["-y", "gmail-server"] },
              env: {
                TOKEN: { from: "link", id: "cred-stale", provider: "gmail", key: "access_token" },
              },
            },
          },
        },
      },
    });
    const manager = makeManager({
      workspace: { id: "ws-1", path: "/tmp/ws-1" },
      config: { workspace: config },
    });

    const recovered = await getWorkspaceSetupState("ws-1", manager, {
      allowStaleIdRecovery: true,
    });
    expect(recovered).toEqual({
      requires_setup: true,
      setup_requirements: [
        expect.objectContaining({ kind: "credential", provider: "gmail", reason: "stale_id" }),
      ],
    });

    await expect(
      getWorkspaceSetupState("ws-1", manager, { allowStaleIdRecovery: false }),
    ).rejects.toMatchObject({ name: "StaleCredentialIdAtImportError" });
  });
});
