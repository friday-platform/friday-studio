import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { BashArgsSchema, executeBash } from "@atlas/mcp-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, registerToolWorker, type ToolWorker } from "./tool-dispatch.ts";

let server: TestNatsServer;
let nc: NatsConnection;
let worker: ToolWorker;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  worker = registerToolWorker(nc, "bash", (req) => executeBash(BashArgsSchema.parse(req.args)));
}, 30_000);

afterAll(async () => {
  await worker.stop();
  await nc.drain();
  await server.stop();
});

const ctx = {
  workspaceId: "ws-test",
  sessionId: `sess-${crypto.randomUUID()}`,
  callerAgentId: "test-agent",
};

describe("bash via NATS dispatch", () => {
  it("round-trips a successful command", async () => {
    const reply = await callTool(nc, "bash", { command: "echo hello" }, ctx);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const result = reply.result as { metadata: { exitCode: number; stdout: string } };
      expect(result.metadata.exitCode).toBe(0);
      expect(result.metadata.stdout).toContain("hello");
    }
  });

  it("reports a non-zero exit code in the result envelope", async () => {
    const reply = await callTool(nc, "bash", { command: "exit 42" }, ctx);
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const result = reply.result as { metadata: { exitCode: number } };
      expect(result.metadata.exitCode).toBe(42);
    }
  });

  it("captures stderr separately from stdout", async () => {
    const reply = await callTool(
      nc,
      "bash",
      { command: "echo to-stdout; echo to-stderr 1>&2" },
      ctx,
    );
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      const result = reply.result as { metadata: { stdout: string; stderr: string } };
      expect(result.metadata.stdout).toContain("to-stdout");
      expect(result.metadata.stderr).toContain("to-stderr");
    }
  });

  it("rejects malformed args with INVALID_REQUEST", async () => {
    // Schema requires `command: string`; passing a number should be rejected
    // by the worker's BashArgsSchema.parse → handler throws → ok=false.
    const reply = await callTool(nc, "bash", { command: 42 }, ctx);
    expect(reply.ok).toBe(false);
  });

  it("aborts the command at the timeout boundary", async () => {
    const start = Date.now();
    await callTool(nc, "bash", { command: "sleep 5", timeout: 100 }, ctx);
    const durationMs = Date.now() - start;
    // Whether the broker reports the timeout as ok=true (process killed by
    // signal, non-zero exit) or ok=false (handler threw) depends on how
    // Deno's signal-on-abort surfaces — both are correct semantics. The
    // load-bearing assertion is that we didn't wait for the full sleep.
    expect(durationMs).toBeLessThan(2000);
  });
});
