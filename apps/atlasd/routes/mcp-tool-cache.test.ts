import {
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LinkCredentialUnavailableError,
  NoDefaultCredentialError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockTool = { description?: string };
type MockDisconnected = { serverId: string; kind: string; message: string };
const mockCreateMCPTools =
  vi.fn<
    (
      configs: Record<string, unknown>,
      logger: unknown,
      options?: { signal?: AbortSignal; toolPrefix?: string },
    ) => Promise<{
      tools: Record<string, MockTool>;
      dispose: () => Promise<void>;
      disconnected: MockDisconnected[];
    }>
  >();

vi.mock("@atlas/mcp", () => ({
  createMCPTools: (...args: Parameters<typeof mockCreateMCPTools>) => mockCreateMCPTools(...args),
}));

const { classifyProbeError, probeAndExtract } = await import("./mcp-tool-cache.ts");

const fakeLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof probeAndExtract>[2];

beforeEach(() => {
  mockCreateMCPTools.mockReset();
});

describe("classifyProbeError", () => {
  it("returns phase 'transient' for LinkCredentialUnavailableError", () => {
    const err = new LinkCredentialUnavailableError({
      credentialId: "cred-1",
      serverName: "github",
    });
    const result = classifyProbeError(err);
    expect(result.phase).toBe("transient");
    expect(result.error).toBe(err.message);
  });

  it("returns phase 'auth' for LinkCredentialNotFoundError (regression)", () => {
    const err = new LinkCredentialNotFoundError("cred-1");
    const result = classifyProbeError(err);
    expect(result.phase).toBe("auth");
  });

  it("returns phase 'auth' for LinkCredentialExpiredError (regression)", () => {
    const err = new LinkCredentialExpiredError("cred-1", "expired_no_refresh");
    const result = classifyProbeError(err);
    expect(result.phase).toBe("auth");
  });

  it("returns phase 'auth' for NoDefaultCredentialError (regression)", () => {
    const err = new NoDefaultCredentialError("github");
    const result = classifyProbeError(err);
    expect(result.phase).toBe("auth");
  });
});

describe("probeAndExtract", () => {
  it("throws LinkCredentialUnavailableError when disconnected kind is credential_temporarily_unavailable", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      dispose,
      disconnected: [
        {
          serverId: "github",
          kind: "credential_temporarily_unavailable",
          message: "Credential is temporarily unavailable. Please try again.",
        },
      ],
    });

    const config = { transport: { type: "stdio" as const, command: "echo", args: [] } };
    await expect(probeAndExtract("github", config, fakeLogger, 1000)).rejects.toBeInstanceOf(
      LinkCredentialUnavailableError,
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("kind-aware probe → classifier yields phase 'transient'", async () => {
    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      dispose: vi.fn().mockResolvedValue(undefined),
      disconnected: [
        {
          serverId: "github",
          kind: "credential_temporarily_unavailable",
          message: "Credential is temporarily unavailable. Please try again.",
        },
      ],
    });

    const config = { transport: { type: "stdio" as const, command: "echo", args: [] } };
    let thrown: unknown;
    try {
      await probeAndExtract("github", config, fakeLogger, 1000);
    } catch (e) {
      thrown = e;
    }
    const result = classifyProbeError(thrown);
    expect(result.phase).toBe("transient");
    expect(result.error).toBe("Credential is temporarily unavailable. Please try again.");
  });

  it("throws LinkCredentialNotFoundError for other disconnected kinds", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    mockCreateMCPTools.mockResolvedValue({
      tools: {},
      dispose,
      disconnected: [
        {
          serverId: "github",
          kind: "credential_not_found",
          message: "Credential missing — reconnect to continue.",
        },
      ],
    });

    const config = { transport: { type: "stdio" as const, command: "echo", args: [] } };
    await expect(probeAndExtract("github", config, fakeLogger, 1000)).rejects.toBeInstanceOf(
      LinkCredentialNotFoundError,
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("other disconnected kinds → classifier yields phase 'auth' (regression)", async () => {
    const kinds = [
      "credential_not_found",
      "credential_expired",
      "credential_refresh_failed",
      "no_default_credential",
    ] as const;

    for (const kind of kinds) {
      mockCreateMCPTools.mockResolvedValueOnce({
        tools: {},
        dispose: vi.fn().mockResolvedValue(undefined),
        disconnected: [{ serverId: "github", kind, message: `disconnected: ${kind}` }],
      });

      const config = { transport: { type: "stdio" as const, command: "echo", args: [] } };
      let thrown: unknown;
      try {
        await probeAndExtract("github", config, fakeLogger, 1000);
      } catch (e) {
        thrown = e;
      }
      const result = classifyProbeError(thrown);
      expect(result.phase, `kind=${kind}`).toBe("auth");
    }
  });
});
