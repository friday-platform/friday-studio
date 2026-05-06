/**
 * Behavioral coverage for `JetStreamElicitationStorageAdapter`.
 *
 * Drives a real `nats-server` (via the shared test fixture) so the
 * stream + KV writes go through the actual JetStream client. Each
 * test seeds a fresh elicitation with a unique id so we can assert on
 * its individual state transition without coupling to other tests.
 *
 * Covers:
 *  - create persists the entity with id/status/createdAt and preserves inputs
 *  - create writes the envelope into the stream + KV
 *  - create sets `Nats-TTL` derived from `expiresAt - now`
 *  - get round-trips a created entity; missing id resolves to ok(null)
 *  - list filters by workspaceId and by status
 *  - answer flips pending → answered + merges the answer field
 *  - decline flips pending → declined and synthesizes an answer block
 *  - status guard: answer on a declined elicitation fails cleanly
 */

import type { NatsConnection } from "nats";
import { beforeAll, describe, expect, it } from "vitest";
// Re-use the worker-shared NATS server (vitest.setup.ts). Each test
// keys its data by a unique workspaceId so writes don't collide with
// other suites sharing the same KV bucket / stream.
import { getTestNc } from "../../../../vitest.setup.ts";
import { JetStreamElicitationStorageAdapter } from "./jetstream-adapter.ts";
import type { CreateElicitationInput } from "./model.ts";

let nc: NatsConnection;

beforeAll(() => {
  nc = getTestNc();
});

function expiresIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function baseInput(overrides: Partial<CreateElicitationInput> = {}): CreateElicitationInput {
  return {
    workspaceId: "ws-elic-test",
    sessionId: "sess-elic-test",
    kind: "open-question",
    question: "Are you sure?",
    expiresAt: expiresIn(60_000),
    ...overrides,
  };
}

describe("JetStreamElicitationStorageAdapter", () => {
  it("create persists the entity with server-assigned id, pending status, and createdAt", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const input = baseInput({
      workspaceId: "ws-create-1",
      sessionId: "sess-create-1",
      question: "Allow tool?",
      kind: "tool-allowlist",
      options: [
        { label: "Allow", value: "allow" },
        { label: "Deny", value: "deny" },
      ],
      pendingTool: { name: "gmail/send_email", args: { to: "x@y.z" } },
    });

    const result = await adapter.create(input);
    expect(result.ok).toBe(true);
    expect.assert(result.ok === true);
    const elic = result.data;

    expect(elic.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(elic.status).toBe("pending");
    expect(elic.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(elic.workspaceId).toBe("ws-create-1");
    expect(elic.sessionId).toBe("sess-create-1");
    expect(elic.question).toBe("Allow tool?");
    expect(elic.kind).toBe("tool-allowlist");
    expect(elic.options).toEqual(input.options);
    expect(elic.pendingTool).toEqual(input.pendingTool);
    expect(elic.expiresAt).toBe(input.expiresAt);
    expect(elic.answer).toBeUndefined();
  });

  it("create writes the envelope into the ELICITATIONS stream", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(
      baseInput({ workspaceId: "ws-stream", sessionId: "sess-stream" }),
    );
    expect.assert(created.ok === true);

    // Confirm the stream now has at least one message under our subject.
    const jsm = await nc.jetstreamManager();
    const info = await jsm.streams.info("ELICITATIONS");
    expect(Number(info.state.messages)).toBeGreaterThanOrEqual(1);
    const stream = await jsm.streams.get("ELICITATIONS");
    const msg = await stream.getMessage({
      last_by_subj: `elicitations.ws-stream.sess-stream.${created.data.id}`,
    });
    expect(msg).toBeDefined();
    const decoded = JSON.parse(new TextDecoder().decode(msg.data)) as {
      id: string;
      status: string;
    };
    expect(decoded.id).toBe(created.data.id);
    expect(decoded.status).toBe("pending");
  });

  it("create sets a Nats-TTL header derived from expiresAt - now", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    // 10s window — easily distinguishable from the 1s floor and the 7d max_age.
    const created = await adapter.create(
      baseInput({ workspaceId: "ws-ttl", sessionId: "sess-ttl", expiresAt: expiresIn(10_000) }),
    );
    expect.assert(created.ok === true);

    const jsm = await nc.jetstreamManager();
    const stream = await jsm.streams.get("ELICITATIONS");
    const msg = await stream.getMessage({
      last_by_subj: `elicitations.ws-ttl.sess-ttl.${created.data.id}`,
    });
    const ttl = msg.header.get("Nats-TTL");
    // Window math is `Math.floor(ttlMs / 1000)` so a 10s setpoint resolves
    // to either "10s" or "9s" depending on test-runner clock skew.
    expect(ttl).toMatch(/^(?:9|10)s$/);
  });

  it("get round-trips a created entity from the KV index", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(baseInput({ workspaceId: "ws-get-rt" }));
    expect.assert(created.ok === true);

    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(got.data).not.toBeNull();
    expect(got.data?.id).toBe(created.data.id);
    expect(got.data?.workspaceId).toBe("ws-get-rt");
    expect(got.data?.status).toBe("pending");
  });

  it("get returns ok(null) — not an error — for an unknown id", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    // Touch the bucket once so it exists (the adapter lazy-creates it on
    // first kv() call inside create/get; either path works for setup).
    await adapter.create(baseInput({ workspaceId: "ws-missing-bootstrap" }));

    const got = await adapter.get({ id: "elc-does-not-exist" });
    expect.assert(got.ok === true);
    expect(got.data).toBeNull();
  });

  it("list({ workspaceId }) filters to entries in that workspace", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const wsTag = `ws-list-${crypto.randomUUID().slice(0, 8)}`;
    const a = await adapter.create(baseInput({ workspaceId: wsTag, question: "a" }));
    const b = await adapter.create(baseInput({ workspaceId: wsTag, question: "b" }));
    await adapter.create(baseInput({ workspaceId: "ws-other", question: "noise" }));
    expect.assert(a.ok === true);
    expect.assert(b.ok === true);

    const listed = await adapter.list({ workspaceId: wsTag });
    expect.assert(listed.ok === true);
    const ids = listed.data.map((e) => e.id);
    expect(ids).toContain(a.data.id);
    expect(ids).toContain(b.data.id);
    for (const elic of listed.data) {
      expect(elic.workspaceId).toBe(wsTag);
    }
  });

  it("list({ status: 'pending' }) filters by lifecycle state", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const wsTag = `ws-status-${crypto.randomUUID().slice(0, 8)}`;
    const pending = await adapter.create(baseInput({ workspaceId: wsTag }));
    const willAnswer = await adapter.create(baseInput({ workspaceId: wsTag }));
    expect.assert(pending.ok === true);
    expect.assert(willAnswer.ok === true);
    await adapter.answer({
      id: willAnswer.data.id,
      answer: { value: "yes", answeredAt: new Date().toISOString() },
    });

    const onlyPending = await adapter.list({ workspaceId: wsTag, status: "pending" });
    expect.assert(onlyPending.ok === true);
    const ids = onlyPending.data.map((e) => e.id);
    expect(ids).toContain(pending.data.id);
    expect(ids).not.toContain(willAnswer.data.id);
    for (const elic of onlyPending.data) {
      expect(elic.status).toBe("pending");
    }
  });

  it("answer transitions pending → answered and merges the answer payload", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(baseInput({ workspaceId: "ws-answer" }));
    expect.assert(created.ok === true);

    const answeredAt = new Date().toISOString();
    const result = await adapter.answer({
      id: created.data.id,
      answer: { value: "allow-once", note: "fine for now", answeredBy: "user-1", answeredAt },
    });
    expect.assert(result.ok === true);
    expect(result.data.status).toBe("answered");
    expect(result.data.answer).toEqual({
      value: "allow-once",
      note: "fine for now",
      answeredBy: "user-1",
      answeredAt,
    });

    // KV reflects the new state too — re-reading should see "answered".
    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(got.data?.status).toBe("answered");
  });

  it("decline transitions pending → declined and records an answer block with note", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(baseInput({ workspaceId: "ws-decline" }));
    expect.assert(created.ok === true);

    const result = await adapter.decline({ id: created.data.id, note: "user dismissed" });
    expect.assert(result.ok === true);
    expect(result.data.status).toBe("declined");
    expect(result.data.answer?.value).toBe("declined");
    expect(result.data.answer?.note).toBe("user dismissed");
    expect(result.data.answer?.answeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("answer on an already-declined elicitation fails with a status-guard error", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(baseInput({ workspaceId: "ws-guard" }));
    expect.assert(created.ok === true);
    const declined = await adapter.decline({ id: created.data.id });
    expect.assert(declined.ok === true);

    const tryAnswer = await adapter.answer({
      id: created.data.id,
      answer: { value: "allow", answeredAt: new Date().toISOString() },
    });
    expect(tryAnswer.ok).toBe(false);
    expect.assert(tryAnswer.ok === false);
    expect(tryAnswer.error).toMatch(/terminal state/i);
    expect(tryAnswer.error).toMatch(/declined/);
  });
});
