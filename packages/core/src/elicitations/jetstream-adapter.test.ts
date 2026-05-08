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
import { RetentionPolicy, StorageType } from "nats";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
// Re-use the worker-shared NATS server (vitest.setup.ts). Each test
// keys its data by a unique workspaceId so writes don't collide with
// other suites sharing the same KV bucket / stream.
import { getTestNc } from "../../../../vitest.setup.ts";
import {
  bootstrapElicitationsStream,
  JetStreamElicitationStorageAdapter,
} from "./jetstream-adapter.ts";
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

  it("concurrent answer/decline allows only one terminal write", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(
      baseInput({ workspaceId: `ws-terminal-race-${crypto.randomUUID()}` }),
    );
    expect.assert(created.ok === true);

    const [answered, declined] = await Promise.all([
      adapter.answer({
        id: created.data.id,
        answer: { value: "allow_once", answeredAt: new Date().toISOString() },
      }),
      adapter.decline({ id: created.data.id, note: "no" }),
    ]);

    const okCount = [answered, declined].filter((r) => r.ok).length;
    expect(okCount).toBe(1);

    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(["answered", "declined"]).toContain(got.data?.status);
    const winner = answered.ok ? answered.data.status : declined.ok ? declined.data.status : null;
    expect(got.data?.status).toBe(winner);
  });

  it("concurrent answer/expire allows only one terminal write", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(
      baseInput({
        workspaceId: `ws-expire-race-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect.assert(created.ok === true);

    const [answered, expired] = await Promise.all([
      adapter.answer({
        id: created.data.id,
        answer: { value: "allow_once", answeredAt: new Date().toISOString() },
      }),
      adapter.expirePending({ now: new Date(Date.now() + 120_000), limit: 500 }),
    ]);

    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(["answered", "expired"]).toContain(got.data?.status);
    if (got.data?.status === "answered") {
      expect(answered.ok).toBe(true);
      expect(expired.ok && expired.data.expired.includes(created.data.id)).toBe(false);
    } else {
      expect(expired.ok && expired.data.expired.includes(created.data.id)).toBe(true);
      expect(answered.ok).toBe(false);
    }
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

// ---------------------------------------------------------------------------
// G4 — pending → expired sweeper + read-time derivation
// ---------------------------------------------------------------------------

describe("JetStreamElicitationStorageAdapter — expirePending sweep", () => {
  it("flips a past-deadline pending entry to expired on tick", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    // Created with a tight deadline (200ms) so by sweep time it's past.
    const created = await adapter.create(
      baseInput({ workspaceId: `ws-sweep-${crypto.randomUUID()}`, expiresAt: expiresIn(200) }),
    );
    expect.assert(created.ok === true);

    // Inject a fake "now" 1 minute past the entry's expiresAt. The KV
    // entry stays untouched between create and sweep — the sweep is
    // the first thing that observes the past-deadline state.
    const fakeNow = new Date(Date.parse(created.data.expiresAt) + 60_000);
    const swept = await adapter.expirePending({ now: fakeNow });
    expect.assert(swept.ok === true);
    expect(swept.data.expired).toContain(created.data.id);

    // KV reflects the durable transition.
    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(got.data?.status).toBe("expired");
  });

  it("leaves an already-answered entry alone (terminal-state idempotence)", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(
      baseInput({ workspaceId: `ws-noop-answered-${crypto.randomUUID()}` }),
    );
    expect.assert(created.ok === true);

    const answered = await adapter.answer({
      id: created.data.id,
      answer: { value: "ok", answeredAt: new Date().toISOString() },
    });
    expect.assert(answered.ok === true);

    // Sweep with a far-future "now" so any past-deadline pending
    // entry would be caught — answered entries must still be skipped.
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const swept = await adapter.expirePending({ now: farFuture });
    expect.assert(swept.ok === true);
    expect(swept.data.expired).not.toContain(created.data.id);

    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(got.data?.status).toBe("answered");
  });

  it("is idempotent across ticks — re-sweeping an already-expired entry is a no-op", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(
      baseInput({ workspaceId: `ws-idem-${crypto.randomUUID()}`, expiresAt: expiresIn(200) }),
    );
    expect.assert(created.ok === true);

    const fakeNow = new Date(Date.parse(created.data.expiresAt) + 60_000);
    const first = await adapter.expirePending({ now: fakeNow });
    expect.assert(first.ok === true);
    expect(first.data.expired).toContain(created.data.id);

    // Second tick — the entry is already `expired`, so the sweep
    // walks past it without writing again.
    const second = await adapter.expirePending({ now: fakeNow });
    expect.assert(second.ok === true);
    expect(second.data.expired).not.toContain(created.data.id);
    expect(second.data.skipped).not.toContain(created.data.id);
  });

  it("CAS-skips when a concurrent answer wins the race", async () => {
    // Race the answer in BEFORE the sweep starts. With the answer
    // already landed, the entry is no longer `pending` so the sweep
    // skips it before the CAS — same observable outcome as a true
    // mid-flight race (answer wins, sweep does not write `expired`).
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const created = await adapter.create(
      baseInput({ workspaceId: `ws-cas-${crypto.randomUUID()}`, expiresAt: expiresIn(200) }),
    );
    expect.assert(created.ok === true);

    const answered = await adapter.answer({
      id: created.data.id,
      answer: { value: "allow_once", answeredAt: new Date().toISOString() },
    });
    expect.assert(answered.ok === true);

    const fakeNow = new Date(Date.parse(created.data.expiresAt) + 60_000);
    const swept = await adapter.expirePending({ now: fakeNow });
    expect.assert(swept.ok === true);
    expect(swept.data.expired).not.toContain(created.data.id);

    // Final state is "answered" — answer wins.
    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(got.data?.status).toBe("answered");
  });
});

describe("JetStreamElicitationStorageAdapter — read-time derivation", () => {
  it("get() surfaces `expired` for a past-deadline pending entry without a sweep", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    // 100ms deadline — past by the time we sleep below.
    const created = await adapter.create(
      baseInput({ workspaceId: `ws-rt-get-${crypto.randomUUID()}`, expiresAt: expiresIn(100) }),
    );
    expect.assert(created.ok === true);

    // Wait past the deadline, no sweep, just a read.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const got = await adapter.get({ id: created.data.id });
    expect.assert(got.ok === true);
    expect(got.data?.status).toBe("expired");
  });

  it("list({status:'pending'}) excludes a past-deadline pending entry", async () => {
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const wsTag = `ws-rt-list-${crypto.randomUUID()}`;
    const stale = await adapter.create(
      baseInput({ workspaceId: wsTag, expiresAt: expiresIn(100) }),
    );
    const fresh = await adapter.create(
      baseInput({ workspaceId: wsTag, expiresAt: expiresIn(60_000) }),
    );
    expect.assert(stale.ok === true);
    expect.assert(fresh.ok === true);

    // Wait past the stale entry's deadline so read-time derivation
    // kicks in. No sweep — the durable status is still `pending`,
    // but the filter must see `expired`.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const pending = await adapter.list({ workspaceId: wsTag, status: "pending" });
    expect.assert(pending.ok === true);
    const ids = pending.data.map((e) => e.id);
    expect(ids).toContain(fresh.data.id);
    expect(ids).not.toContain(stale.data.id);

    // The same entry shows up under status:"expired" via derivation.
    const expired = await adapter.list({ workspaceId: wsTag, status: "expired" });
    expect.assert(expired.ok === true);
    expect(expired.data.map((e) => e.id)).toContain(stale.data.id);
  });
});

// ---------------------------------------------------------------------------
// C2 — ensureStream config-drift / migration-race guard
// ---------------------------------------------------------------------------
//
// The adapter no longer self-creates the ELICITATIONS stream — it
// validates the migration ran. These tests exercise the failure paths:
// missing stream and config drift (allow_msg_ttl: false). Both must
// surface a clear error pointing at the migration instead of silently
// succeeding (and then having every publish rejected by the broker).
//
// Each test deletes the global ELICITATIONS stream up front so the
// shared test-server state is well-defined. `afterEach` re-runs the
// bootstrap helper so subsequent suites inherit a healthy stream.

describe("JetStreamElicitationStorageAdapter — ensureStream validation (C2)", () => {
  afterEach(async () => {
    // Restore the healthy stream config so other suites can keep using
    // the worker-shared server.
    await bootstrapElicitationsStream(nc);
  });

  it("errors clearly when the ELICITATIONS stream is missing entirely", async () => {
    const jsm = await nc.jetstreamManager();
    await jsm.streams.delete("ELICITATIONS");

    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const result = await adapter.create(baseInput({ workspaceId: "ws-no-stream" }));
    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    // The error must name the migration so an operator knows the fix.
    expect(result.error).toMatch(/ELICITATIONS stream missing/);
    expect(result.error).toMatch(/m_20260505_120000_elicitations_bootstrap/);
  });

  it("errors clearly when the stream exists with allow_msg_ttl disabled (legacy config)", async () => {
    // Simulate a legacy daemon that created the stream before the
    // allow_msg_ttl flag existed. Drop and recreate without the flag.
    const jsm = await nc.jetstreamManager();
    await jsm.streams.delete("ELICITATIONS");
    await jsm.streams.add({
      name: "ELICITATIONS",
      subjects: ["elicitations.>"],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      // Note: NO allow_msg_ttl flag — this is the C2 race outcome.
    });

    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const result = await adapter.create(baseInput({ workspaceId: "ws-legacy-cfg" }));
    expect(result.ok).toBe(false);
    expect.assert(result.ok === false);
    expect(result.error).toMatch(/allow_msg_ttl is not enabled/);
    expect(result.error).toMatch(/m_20260505_120000_elicitations_bootstrap/);
  });

  it("succeeds after bootstrapElicitationsStream heals a legacy-config stream", async () => {
    // Legacy stream first.
    const jsm = await nc.jetstreamManager();
    await jsm.streams.delete("ELICITATIONS");
    await jsm.streams.add({
      name: "ELICITATIONS",
      subjects: ["elicitations.>"],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
    });

    // Run the bootstrap helper — it should `streams.update` in-place
    // to add allow_msg_ttl: true. Adapter creates then succeed.
    await bootstrapElicitationsStream(nc);
    const adapter = new JetStreamElicitationStorageAdapter(nc);
    const result = await adapter.create(baseInput({ workspaceId: "ws-healed" }));
    expect(result.ok).toBe(true);
  });
});
