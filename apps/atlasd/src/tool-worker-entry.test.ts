import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool } from "./tool-dispatch.ts";
import { startToolWorkerProcess } from "./tool-worker-entry.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

const ctx = { workspaceId: "ws", sessionId: "sess", callerAgentId: "agent" };

describe("tool-worker-entry — standalone worker", () => {
  it("registers handlers and serves callTool over NATS", async () => {
    const proc = await startToolWorkerProcess({ natsUrl: server.url });
    try {
      const reply = await callTool(nc, "bash", { command: "echo from-worker-process" }, ctx);
      expect(reply.ok).toBe(true);
      if (reply.ok) {
        const result = reply.result as { metadata: { stdout: string } };
        expect(result.metadata.stdout).toContain("from-worker-process");
      }
    } finally {
      await proc.stop();
    }
  });

  it("respects FRIDAY_WORKER_TOOLS allowlist", async () => {
    const proc = await startToolWorkerProcess({ natsUrl: server.url, toolsAllowlist: "webfetch" });
    try {
      // bash is filtered out → no worker on tools.bash.call → request times out.
      await expect(
        callTool(nc, "bash", { command: "echo nope" }, { ...ctx, timeoutMs: 250 }),
      ).rejects.toThrow();
    } finally {
      await proc.stop();
    }
  });
});
