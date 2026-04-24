import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** Response shape for error responses */
const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  phase: z.string().optional(),
});

/** Response shape for successful register responses */
const SuccessResponseSchema = z.object({
  ok: z.literal(true),
  agent: z.object({
    id: z.string(),
    version: z.string(),
    description: z.string(),
    path: z.string(),
  }),
});

// --- Mock NATS subscription helper ---

/** Simulates a NATS subscription that yields one message then stops. */
function makeMockSub(payload: unknown) {
  let consumed = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (consumed) return Promise.resolve({ value: undefined, done: true as const });
          consumed = true;
          return Promise.resolve({
            value: { data: new TextEncoder().encode(JSON.stringify(payload)) },
            done: false as const,
          });
        },
      };
    },
    unsubscribe: vi.fn(),
  };
}

const mockSubscribe = vi.fn();
const mockKill = vi.fn();
const mockSpawn = vi.fn();

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("nats", () => ({
  StringCodec: () => ({
    encode: (s: string) => new TextEncoder().encode(s),
    decode: (b: Uint8Array) => new TextDecoder().decode(b),
  }),
}));

vi.mock("@atlas/utils/paths.server", () => ({ getAtlasHome: () => "/mock-atlas-home" }));

vi.mock("node:fs/promises", () => ({
  cp: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("content")),
  rename: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:crypto", () => ({
  createHash: () => ({
    update: function () {
      return this;
    },
    digest: () => "abc123",
  }),
}));

vi.mock("@atlas/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

const { registerAgentRoute } = await import("./register.ts");
const { daemonFactory } = await import("../../src/factory.ts");

function makeApp(subPayload: unknown = null) {
  const app = daemonFactory.createApp();
  app.use("*", async (c, next) => {
    const sub = subPayload !== null ? makeMockSub(subPayload) : null;
    c.set("app", {
      daemon: { getNatsConnection: () => ({ subscribe: mockSubscribe.mockReturnValue(sub) }) },
      getAgentRegistry: () => ({ reload: vi.fn() }),
    } as never);
    await next();
  });
  app.route("/", registerAgentRoute);
  return app;
}

function makeProc() {
  return { kill: mockKill, stderr: { on: vi.fn() } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSpawn.mockReturnValue(makeProc());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /register", () => {
  it("rejects non-JSON requests", async () => {
    const app = makeApp({ id: "test", version: "1.0.0", description: "test" });
    const response = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.error).toContain("JSON");
  });

  it("rejects missing entrypoint", async () => {
    const app = makeApp();
    const response = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.error).toContain("entrypoint");
  });

  it("returns registered agent on success", async () => {
    const app = makeApp({ id: "test-agent", version: "1.0.0", description: "A test agent" });

    const response = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entrypoint: "/some/dir/agent.py" }),
    });

    expect(response.status).toBe(200);
    const body = SuccessResponseSchema.parse(await response.json());
    expect(body.agent.id).toBe("test-agent");
    expect(body.agent.version).toBe("1.0.0");
    expect(body.agent.description).toBe("A test agent");
    expect(body.agent.path).toContain("test-agent@1.0.0");
  });

  it("spawns python3 for .py entrypoints", async () => {
    const app = makeApp({ id: "py-agent", version: "1.0.0", description: "Python agent" });

    await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entrypoint: "/agents/agent.py" }),
    });

    expect(mockSpawn).toHaveBeenCalledWith("python3", ["/agents/agent.py"], expect.anything());
  });

  it("spawns deno for .ts entrypoints", async () => {
    const app = makeApp({ id: "ts-agent", version: "1.0.0", description: "TS agent" });

    await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entrypoint: "/agents/agent.ts" }),
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "deno",
      expect.arrayContaining(["run", "/agents/agent.ts"]),
      expect.anything(),
    );
  });

  it("returns 400 for invalid metadata from agent", async () => {
    // Agent publishes invalid metadata (missing required fields)
    const app = makeApp({ id: "bad-agent" }); // missing version and description

    const response = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entrypoint: "/agents/agent.py" }),
    });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.phase).toBe("validate");
  });

  it("passes ATLAS_VALIDATE_ID and NATS_URL to spawned process", async () => {
    const app = makeApp({ id: "env-agent", version: "1.0.0", description: "Env test" });

    await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entrypoint: "/agents/agent.py" }),
    });

    const spawnCall = mockSpawn.mock.calls[0];
    const env = spawnCall?.[2]?.env as Record<string, string>;
    expect(env).toMatchObject({
      ATLAS_VALIDATE_ID: expect.any(String),
      NATS_URL: "nats://localhost:4222",
    });
  });

  it("kills process after validate completes", async () => {
    const app = makeApp({ id: "kill-agent", version: "1.0.0", description: "Kill test" });

    await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entrypoint: "/agents/agent.py" }),
    });

    expect(mockKill).toHaveBeenCalledWith("SIGTERM");
  });
});
