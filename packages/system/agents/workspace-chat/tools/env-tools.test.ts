import { createLogger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/core/elicitations", async () => {
  const actual = await vi.importActual<typeof import("@atlas/core/elicitations")>(
    "@atlas/core/elicitations",
  );
  return { ...actual, ElicitationStorage: { create: vi.fn() } };
});

import { ElicitationStorage } from "@atlas/core/elicitations";
import { createEnvTools } from "./env-tools.ts";

const logger = createLogger({ name: "test" });
const ctx = { toolCallId: "tc_1", messages: [] };
const baseOpts = {
  workspaceId: "ws_test",
  sessionId: "chat_session",
  daemonUrl: "http://localhost:9999",
  logger,
};

// `tool({ execute })` from `ai` — invoked directly in tests (no schema pass).
interface ExecTool {
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
}

function tools() {
  const t = createEnvTools(baseOpts) as unknown as { env_set: ExecTool; env_get: ExecTool };
  return t;
}

describe("env_set", () => {
  const create = vi.mocked(ElicitationStorage.create);

  beforeEach(() => create.mockReset());

  it("raises an env-write elicitation with the correct payload", async () => {
    create.mockResolvedValueOnce({ ok: true, data: { id: "elc_1" } } as never);

    const result = await tools().env_set.execute(
      { scope: "workspace", vars: { BITBUCKET_WORKSPACE: "insanelygreatteam" } },
      ctx,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "env-write",
        workspaceId: "ws_test",
        sessionId: "chat_session",
        pendingTool: {
          name: "env_set",
          args: { scope: "workspace", vars: { BITBUCKET_WORKSPACE: "insanelygreatteam" } },
        },
      }),
    );
    expect(result).toMatchObject({
      status: "pending_confirmation",
      elicitationId: "elc_1",
      scope: "workspace",
      keys: ["BITBUCKET_WORKSPACE"],
    });
  });

  it("rejects the MASKED_VALUE sentinel without raising an elicitation", async () => {
    const result = await tools().env_set.execute(
      { scope: "workspace", vars: { API_KEY: "********" } },
      ctx,
    );

    expect(create).not.toHaveBeenCalled();
    expect(result.error).toContain("masked sentinel");
  });

  it("flags secret-looking keys in the result note", async () => {
    create.mockResolvedValueOnce({ ok: true, data: { id: "elc_2" } } as never);

    const result = await tools().env_set.execute(
      { scope: "workspace", vars: { GITHUB_TOKEN: "ghp_real" } },
      ctx,
    );

    expect(result).toMatchObject({ secretLookingKeys: ["GITHUB_TOKEN"] });
  });

  it("returns a structured error when elicitation creation fails", async () => {
    create.mockResolvedValueOnce({ ok: false, error: "storage down" } as never);

    const result = await tools().env_set.execute(
      { scope: "global", vars: { LOG_LEVEL: "info" } },
      ctx,
    );

    expect(result.error).toContain("storage down");
  });

  it("schema rejects non-POSIX keys and newline values", () => {
    const schema = tools().env_set.inputSchema;
    expect(schema.safeParse({ vars: { "bad-key": "v" } }).success).toBe(false);
    expect(schema.safeParse({ vars: { GOOD_KEY: "line1\nline2" } }).success).toBe(false);
    expect(schema.safeParse({ vars: { GOOD_KEY: "value" } }).success).toBe(true);
  });
});

describe("env_get", () => {
  let prevFetch: typeof globalThis.fetch;

  beforeEach(() => {
    prevFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = prevFetch;
  });

  it("masks secret-looking keys", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ value: "ghp_realsecret" }),
      }) as unknown as typeof fetch;

    const result = await tools().env_get.execute({ scope: "workspace", key: "API_TOKEN" }, ctx);

    expect(result).toMatchObject({
      key: "API_TOKEN",
      found: true,
      value: "********",
      masked: true,
    });
  });

  it("returns the real value for non-secret keys", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({
        status: 200,
        ok: true,
        json: () => Promise.resolve({ value: "insanelygreatteam" }),
      }) as unknown as typeof fetch;

    const result = await tools().env_get.execute(
      { scope: "workspace", key: "BITBUCKET_WORKSPACE" },
      ctx,
    );

    expect(result).toMatchObject({ found: true, value: "insanelygreatteam" });
    expect(result.masked).toBeUndefined();
  });

  it("returns found:false on 404", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ status: 404, ok: false }) as unknown as typeof fetch;

    const result = await tools().env_get.execute({ scope: "workspace", key: "MISSING" }, ctx);

    expect(result).toMatchObject({ key: "MISSING", found: false });
  });

  it("returns a structured error on non-ok HTTP", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({
        status: 500,
        ok: false,
        text: () => Promise.resolve("internal error"),
      }) as unknown as typeof fetch;

    const result = await tools().env_get.execute({ scope: "workspace", key: "FOO" }, ctx);

    expect(result.error).toContain("HTTP 500");
  });

  it("returns a structured error when fetch throws", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const result = await tools().env_get.execute({ scope: "workspace", key: "FOO" }, ctx);

    expect(result.error).toContain("network error");
    expect(result.error).toContain("ECONNREFUSED");
  });
});
