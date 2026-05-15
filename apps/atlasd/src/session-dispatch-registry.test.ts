/**
 * Tests for SessionDispatchRegistry — daemon-level NATS-backed cancel routing.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  publishSessionCancel,
  SessionDispatchRegistry,
  sessionCancelSubject,
} from "./session-dispatch-registry.ts";

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

describe("sessionCancelSubject", () => {
  it("encodes the sessionId under the daemon.cancel.sessions namespace", () => {
    expect(sessionCancelSubject("sess-abc")).toBe("daemon.cancel.sessions.sess-abc");
  });

  it("sanitizes characters NATS subjects can't carry (`.`, `*`, `>`)", () => {
    // A `.` in a sessionId would be interpreted as a subject delimiter and
    // break the wildcard match. Same for `*` / `>` (NATS wildcards). All
    // get replaced with `_` so the subject stays one-token-deep.
    expect(sessionCancelSubject("a.b")).toBe("daemon.cancel.sessions.a_b");
    expect(sessionCancelSubject("a*b")).toBe("daemon.cancel.sessions.a_b");
    expect(sessionCancelSubject("a>b")).toBe("daemon.cancel.sessions.a_b");
  });
});

describe("SessionDispatchRegistry", () => {
  let registry: SessionDispatchRegistry;

  beforeEach(async () => {
    registry = new SessionDispatchRegistry(nc);
    await registry.start();
  });

  afterEach(async () => {
    await registry.stop();
  });

  it("publishSessionCancel → subscription → controller.abort with AbortError", async () => {
    const controller = new AbortController();
    const aborted = new Promise<Error>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        resolve(controller.signal.reason as Error);
      });
    });

    registry.register("sess-1", controller, { workspaceId: "ws-1", signalId: "sig-1" });
    await publishSessionCancel(nc, "sess-1", "user clicked cancel");

    const reason = await aborted;
    expect(reason).toBeInstanceOf(Error);
    expect(reason.name).toBe("AbortError"); // load-bearing — classifySessionError reads it
    expect(reason.message).toBe("user clicked cancel");
  });

  it("falls back to a default reason when payload omits one", async () => {
    const controller = new AbortController();
    const aborted = new Promise<Error>((resolve) => {
      controller.signal.addEventListener("abort", () => {
        resolve(controller.signal.reason as Error);
      });
    });

    registry.register("sess-2", controller, { workspaceId: "ws-1", signalId: "sig-1" });
    await publishSessionCancel(nc, "sess-2");

    const reason = await aborted;
    expect(reason.name).toBe("AbortError");
    expect(reason.message).toBe("Session cancelled");
  });

  it("ignores cancels for unknown sessions (no throw, no abort)", async () => {
    // Should not throw — nothing to abort, but the subscription must keep
    // running for subsequent cancels. We verify by issuing a no-op cancel
    // then a real cancel and confirming the real one still lands.
    await publishSessionCancel(nc, "sess-unknown", "noise");

    const controller = new AbortController();
    const aborted = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve());
    });

    registry.register("sess-real", controller, { workspaceId: "ws-1", signalId: "sig-1" });
    await publishSessionCancel(nc, "sess-real");
    await aborted;
    expect(controller.signal.aborted).toBe(true);
  });

  it("tolerates malformed JSON payloads — sessionId in the subject is authoritative", async () => {
    const controller = new AbortController();
    const aborted = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve());
    });

    registry.register("sess-malformed", controller, { workspaceId: "ws-1", signalId: "sig-1" });
    nc.publish(sessionCancelSubject("sess-malformed"), new TextEncoder().encode("{not-json"));
    await nc.flush();

    await aborted;
    expect(controller.signal.aborted).toBe(true);
    // No reason extracted — falls back to default.
    expect((controller.signal.reason as Error).message).toBe("Session cancelled");
  });

  it("deregister() unhooks the controller — subsequent cancels are no-ops", async () => {
    const controller = new AbortController();
    registry.register("sess-3", controller, { workspaceId: "ws-1", signalId: "sig-1" });
    registry.deregister("sess-3");

    await publishSessionCancel(nc, "sess-3");
    // Wait long enough for the publish to round-trip even if the registry
    // were going to act on it. Keep small to avoid slow tests.
    await new Promise((r) => setTimeout(r, 50));

    expect(controller.signal.aborted).toBe(false);
  });

  it("workspaceOf returns the registered workspace for active sessions", () => {
    const controller = new AbortController();
    registry.register("sess-4", controller, { workspaceId: "ws-42", signalId: "sig-x" });
    expect(registry.workspaceOf("sess-4")).toBe("ws-42");
    expect(registry.workspaceOf("sess-unknown")).toBeUndefined();
  });

  it("list() snapshots all currently-tracked sessions", () => {
    registry.register("a", new AbortController(), { workspaceId: "ws-A", signalId: "s1" });
    registry.register("b", new AbortController(), { workspaceId: "ws-B", signalId: "s2" });

    const snap = registry.list();
    expect(snap).toHaveLength(2);
    expect(snap).toEqual(
      expect.arrayContaining([
        { sessionId: "a", workspaceId: "ws-A", signalId: "s1" },
        { sessionId: "b", workspaceId: "ws-B", signalId: "s2" },
      ]),
    );
  });

  it("stop() is idempotent and clears entries", async () => {
    registry.register("sess-stop", new AbortController(), {
      workspaceId: "ws-1",
      signalId: "sig-1",
    });

    await registry.stop();
    await registry.stop(); // second call must not throw

    expect(registry.has("sess-stop")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it("publish before subscribe-flush completes can land on a live subscriber", async () => {
    // Negative regression check for the subscribe-then-flush ordering: by
    // the time start() returns, a publish must hit a server-registered
    // subscription. We start a fresh registry and immediately publish.
    const fresh = new SessionDispatchRegistry(nc);
    await fresh.start();

    const controller = new AbortController();
    const aborted = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve());
    });
    fresh.register("sess-flush", controller, { workspaceId: "ws-1", signalId: "sig-1" });

    await publishSessionCancel(nc, "sess-flush");
    await aborted;
    expect(controller.signal.aborted).toBe(true);

    await fresh.stop();
  });

  it("multiple registered controllers each receive their own cancels", async () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const controllerC = new AbortController();
    const abortedA = new Promise<void>((resolve) => {
      controllerA.signal.addEventListener("abort", () => resolve());
    });
    const abortedC = new Promise<void>((resolve) => {
      controllerC.signal.addEventListener("abort", () => resolve());
    });

    registry.register("sess-A", controllerA, { workspaceId: "ws-1", signalId: "s" });
    registry.register("sess-B", controllerB, { workspaceId: "ws-1", signalId: "s" });
    registry.register("sess-C", controllerC, { workspaceId: "ws-1", signalId: "s" });

    // Cancel A and C, leave B alone.
    await publishSessionCancel(nc, "sess-A");
    await publishSessionCancel(nc, "sess-C");
    await abortedA;
    await abortedC;

    expect(controllerA.signal.aborted).toBe(true);
    expect(controllerB.signal.aborted).toBe(false);
    expect(controllerC.signal.aborted).toBe(true);
  });
});
