import { describe, expect, it, vi } from "vitest";

interface MutationConfig {
  mutationFn: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, vars: unknown) => void;
}

// Mock svelte-query so the query/mutation factories evaluate in a node test.
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
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// Capture per-key requests to the workspace env client without real network.
const putKey = vi.fn(async () => new Response(JSON.stringify({ success: true, key: "K" })));
const putIdentity = vi.fn(async () => new Response(JSON.stringify({ ok: true })));

vi.mock("../daemon-client.ts", () => ({
  getDaemonClient: () => ({
    workspaceEnv: () => ({
      index: { $get: vi.fn() },
      ":key": { $put: putKey },
    }),
    workspaceConfig: () => ({ identity: { $put: putIdentity } }),
  }),
}));

const { workspaceEnvQueries, useSetWorkspaceEnvVar, useUpdateWorkspaceIdentity } = await import(
  "./workspace-settings-queries.ts"
);

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
