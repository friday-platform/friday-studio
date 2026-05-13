import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

interface MutationConfig {
  mutationFn: (vars: unknown) => Promise<unknown>;
  onSuccess?: () => void;
}

// Mock svelte-query so .svelte imports from node_modules don't break node tests
vi.mock("@tanstack/svelte-query", () => ({
  createMutation: (fn: () => MutationConfig) => {
    const config = fn();
    return {
      mutateAsync: async (vars: unknown) => {
        if (config.mutationFn) {
          return await config.mutationFn(vars);
        }
        throw new Error("No mutationFn");
      },
      mutate: (vars: unknown, opts?: { onSettled?: () => void }) => {
        config
          .mutationFn(vars)
          .then(() => {
            if (config.onSuccess) config.onSuccess();
            opts?.onSettled?.();
          })
          .catch(() => {
            opts?.onSettled?.();
          });
      },
      isPending: false,
      error: null,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

// Mock fetch so we can assert requests without real network calls
const originalFetch = globalThis.fetch;

describe("link-credentials mutations — fetch behavior", () => {
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("DELETE sends request to correct path", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    const { useDeleteCredential } = await import("./link-credentials.ts");
    const mutation = useDeleteCredential();

    await mutation.mutateAsync("cred-abc");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/daemon/api/link/v1/credentials/cred-abc",
      { method: "DELETE" },
    );
  });

  it("DELETE extracts error message from response body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Credential in use" }),
        { status: 409 },
      ),
    );

    const { useDeleteCredential } = await import("./link-credentials.ts");
    const mutation = useDeleteCredential();

    await expect(mutation.mutateAsync("cred-abc")).rejects.toThrow("Credential in use");
  });

  it("PATCH sends secret to correct path with correct body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cred-abc",
          type: "apikey",
          provider: "openai",
          label: "x",
          isDefault: false,
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-02T00:00:00.000Z",
        }),
        { status: 200 },
      ),
    );

    const { useUpdateCredentialSecret } = await import("./link-credentials.ts");
    const mutation = useUpdateCredentialSecret();

    await mutation.mutateAsync({
      id: "cred-abc",
      secret: { apiKey: "new-key" },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/daemon/api/link/v1/credentials/cred-abc",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: { apiKey: "new-key" } }),
      },
    );
  });

  it("PATCH extracts error from message field first", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Validation failed" }),
        { status: 400 },
      ),
    );

    const { useUpdateCredentialSecret } = await import("./link-credentials.ts");
    const mutation = useUpdateCredentialSecret();

    await expect(
      mutation.mutateAsync({ id: "cred-abc", secret: { bad: true } }),
    ).rejects.toThrow("Validation failed");
  });
});
