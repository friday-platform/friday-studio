import type { VariableState } from "@atlas/workspace";
import { describe, expect, it, vi } from "vitest";

interface MutationConfig {
  mutationFn: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, vars: unknown) => void;
}

// Mock svelte-query so the query/mutation factories evaluate in a node test.
const invalidateQueries = vi.fn();
const ensureQueryDataMock = vi.fn();

vi.mock("@tanstack/svelte-query", () => ({
  createMutation: (fn: () => MutationConfig) => {
    const config = fn();
    return {
      mutateAsync: async (vars: unknown) => {
        const result = await config.mutationFn(vars);
        config.onSuccess?.(result, vars);
        return result;
      },
      isPending: false,
      error: null,
    };
  },
  queryOptions: <T extends object>(opts: T): T => opts,
  skipToken: Symbol.for("skipToken"),
  useQueryClient: () => ({
    invalidateQueries,
    ensureQueryData: ensureQueryDataMock,
  }),
}));

// Capture per-key requests to the workspace env client without real network.
const putKey = vi.fn(async () => new Response(JSON.stringify({ success: true, key: "K" })));
const deleteKey = vi.fn(async () => new Response(JSON.stringify({ success: true })));
const putIdentity = vi.fn(async () => new Response(JSON.stringify({ ok: true })));

vi.mock("../daemon-client.ts", () => ({
  getDaemonClient: () => ({
    workspaceEnv: () => ({
      index: { $get: vi.fn() },
      ":key": { $put: putKey, $delete: deleteKey },
    }),
    workspaceConfig: () => ({ identity: { $put: putIdentity } }),
    workspaceVariables: () => ({ index: { $get: vi.fn() } }),
  }),
}));

const {
  SaveWorkspaceDetailsError,
  useSaveWorkspaceDetails,
  useSetWorkspaceEnvVar,
  useUpdateWorkspaceIdentity,
  workspaceEnvQueries,
  workspaceVariableQueries,
} = await import("./workspace-settings-queries.ts");

describe("workspaceEnvQueries", () => {
  it("exposes a hierarchical base key", () => {
    expect(workspaceEnvQueries.all("ws-1")).toEqual(["daemon", "workspace", "ws-1", "env"]);
  });

  it("keys list by workspace id with a 30s staleTime", () => {
    const options = workspaceEnvQueries.list("ws-1");
    expect(options.queryKey).toEqual(["daemon", "workspace", "ws-1", "env", "list"]);
    expect(options.staleTime).toBe(30_000);
  });

  it("uses skipToken when workspaceId is null", () => {
    expect(workspaceEnvQueries.list(null).queryFn).toBe(Symbol.for("skipToken"));
  });
});

describe("workspaceVariableQueries", () => {
  it("exposes a hierarchical base key", () => {
    expect(workspaceVariableQueries.all("ws-1")).toEqual([
      "daemon",
      "workspace",
      "ws-1",
      "variables",
    ]);
  });

  it("keys list by workspace id with a 30s staleTime", () => {
    const options = workspaceVariableQueries.list("ws-1");
    expect(options.queryKey).toEqual(["daemon", "workspace", "ws-1", "variables", "list"]);
    expect(options.staleTime).toBe(30_000);
  });

  it("uses skipToken when workspaceId is null", () => {
    expect(workspaceVariableQueries.list(null).queryFn).toBe(Symbol.for("skipToken"));
  });
});

describe("workspace env mutations", () => {
  it("PUTs a single key with its value", async () => {
    const mut = useSetWorkspaceEnvVar();
    await mut.mutateAsync({ workspaceId: "ws-1", key: "API_KEY", value: "v" });
    expect(putKey).toHaveBeenCalledWith({ param: { key: "API_KEY" }, json: { value: "v" } });
  });

  it("PUTs the identity patch as the json body", async () => {
    const mut = useUpdateWorkspaceIdentity();
    await mut.mutateAsync({ workspaceId: "ws-1", patch: { name: "Renamed" } });
    expect(putIdentity).toHaveBeenCalledWith({ json: { name: "Renamed" } });
  });
});

// Helper for building a VariableState row in test fixtures.
function variableState(
  name: string,
  schema: VariableState["declaration"]["schema"],
  overrides: Partial<VariableState> = {},
): VariableState {
  return {
    name,
    declaration: { schema },
    value: null,
    effective_value: null,
    source: "unset",
    is_filled: false,
    ...overrides,
  };
}

describe("useSaveWorkspaceDetails", () => {
  it("commits identity + variable sets + variable deletes in order and invalidates caches", async () => {
    putKey.mockClear();
    deleteKey.mockClear();
    putIdentity.mockClear();
    invalidateQueries.mockClear();
    ensureQueryDataMock.mockReset();

    ensureQueryDataMock.mockResolvedValueOnce([
      variableState("email_recipient", { type: "string" }),
      variableState("threshold", { type: "integer", minimum: 0 }),
    ]);

    const mut = useSaveWorkspaceDetails();
    await mut.mutateAsync({
      workspaceId: "ws-1",
      identityPatch: { name: "Renamed" },
      variableSets: { email_recipient: "alice@example.com", threshold: "42" },
      variableDeletes: ["stale_var"],
    });

    expect(putIdentity).toHaveBeenCalledWith({ json: { name: "Renamed" } });
    expect(putKey).toHaveBeenCalledTimes(2);
    expect(putKey).toHaveBeenNthCalledWith(1, {
      param: { key: "EMAIL_RECIPIENT" },
      json: { value: "alice@example.com" },
    });
    expect(putKey).toHaveBeenNthCalledWith(2, {
      param: { key: "THRESHOLD" },
      json: { value: "42" },
    });
    expect(deleteKey).toHaveBeenCalledWith({ param: { key: "STALE_VAR" } });

    const invalidatedKeys = invalidateQueries.mock.calls.map(
      (call) => (call[0] as { queryKey: readonly unknown[] }).queryKey,
    );
    expect(invalidatedKeys).toEqual(
      expect.arrayContaining([
        ["daemon", "workspace", "ws-1", "config"],
        ["daemon", "workspace", "ws-1", "variables"],
        ["daemon", "workspaces"],
      ]),
    );
  });

  it("pre-flight failure aborts before any HTTP write (identity untouched)", async () => {
    putKey.mockClear();
    deleteKey.mockClear();
    putIdentity.mockClear();
    invalidateQueries.mockClear();
    ensureQueryDataMock.mockReset();

    ensureQueryDataMock.mockResolvedValueOnce([
      variableState("threshold", { type: "integer", minimum: 0 }),
    ]);

    const mut = useSaveWorkspaceDetails();
    await expect(
      mut.mutateAsync({
        workspaceId: "ws-1",
        identityPatch: { name: "Renamed" },
        variableSets: { threshold: "not-an-integer" },
        variableDeletes: [],
      }),
    ).rejects.toMatchObject({
      name: "SaveWorkspaceDetailsError",
      fieldErrors: { threshold: expect.any(String) },
      commitResults: undefined,
    });

    expect(putIdentity).not.toHaveBeenCalled();
    expect(putKey).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("partial commit failure carries commitResults for every attempted write", async () => {
    putKey.mockClear();
    deleteKey.mockClear();
    putIdentity.mockClear();
    invalidateQueries.mockClear();
    ensureQueryDataMock.mockReset();

    ensureQueryDataMock.mockResolvedValueOnce([
      variableState("first", { type: "string" }),
      variableState("second", { type: "string" }),
    ]);

    putKey
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, key: "FIRST" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: "disk_full", message: "Out of disk" }), {
          status: 507,
        }),
      );

    const mut = useSaveWorkspaceDetails();
    let caught: unknown;
    try {
      await mut.mutateAsync({
        workspaceId: "ws-1",
        identityPatch: { name: "Renamed" },
        variableSets: { first: "ok", second: "boom" },
        variableDeletes: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SaveWorkspaceDetailsError);
    const err = caught as InstanceType<typeof SaveWorkspaceDetailsError>;
    expect(err.fieldErrors).toMatchObject({ second: expect.stringContaining("Out of disk") });
    expect(err.commitResults).toEqual([
      { key: "identity", status: "ok" },
      { key: "FIRST", status: "ok" },
      { key: "SECOND", status: "error", error: expect.stringContaining("Out of disk") },
    ]);

    expect(putIdentity).toHaveBeenCalledTimes(1);
    expect(putKey).toHaveBeenCalledTimes(2);
    expect(deleteKey).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
