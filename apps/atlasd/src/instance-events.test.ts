/**
 * Unit tests for `filterCascadeForUser`. The live firehose at
 * `/api/me/stream` and the replay at `/api/instance/events` both apply
 * this filter; keeping them in lockstep is what stops a member of one
 * workspace from seeing another workspace's session ids / signal ids /
 * deepestSignal hints in instance-wide cascade telemetry.
 */

import { describe, expect, it } from "vitest";
import { filterCascadeForUser } from "./instance-events.ts";

const wsAccessible = new Set(["ws-allowed"]);

describe("filterCascadeForUser", () => {
  it("forwards workspace-scoped events when the caller is a member", () => {
    const evt = {
      type: "cascade.queue_timeout" as const,
      at: "2026-05-11T00:00:00Z",
      workspaceId: "ws-allowed",
      signalId: "sig-1",
      queuedMs: 42,
    };
    expect(filterCascadeForUser(evt, wsAccessible)).toEqual(evt);
  });

  it("drops queue_timeout for a non-member workspace", () => {
    const evt = {
      type: "cascade.queue_timeout" as const,
      at: "2026-05-11T00:00:00Z",
      workspaceId: "ws-OTHER",
      signalId: "sig-leak",
      queuedMs: 42,
      correlationId: "corr-leak",
    };
    expect(filterCascadeForUser(evt, wsAccessible)).toBeNull();
  });

  it("drops cascade.replaced for a non-member workspace", () => {
    // Session ids inside replace events are workspace-internal — the
    // entire event has to disappear, not just be redacted.
    const evt = {
      type: "cascade.replaced" as const,
      at: "2026-05-11T00:00:00Z",
      workspaceId: "ws-OTHER",
      signalId: "sig-leak",
      cancelledSessionId: "sess-old",
      newSessionId: "sess-new",
    };
    expect(filterCascadeForUser(evt, wsAccessible)).toBeNull();
  });

  it("redacts deepestSignal on queue_saturated when its workspace isn't accessible", () => {
    const evt = {
      type: "cascade.queue_saturated" as const,
      at: "2026-05-11T00:00:00Z",
      inFlight: 8,
      cap: 10,
      backlog: 12,
      deepestSignal: "ws-OTHER:sig-leak",
    };
    const filtered = filterCascadeForUser(evt, wsAccessible);
    expect(filtered).not.toBeNull();
    expect(filtered).toEqual({
      type: "cascade.queue_saturated",
      at: "2026-05-11T00:00:00Z",
      inFlight: 8,
      cap: 10,
      backlog: 12,
    });
    // Aggregate counts are operator-level signal; the user gets to see
    // "the daemon is busy" even when the busiest workspace isn't one
    // they're a member of.
  });

  it("keeps deepestSignal on queue_saturated when its workspace IS accessible", () => {
    const evt = {
      type: "cascade.queue_saturated" as const,
      at: "2026-05-11T00:00:00Z",
      inFlight: 8,
      cap: 10,
      backlog: 12,
      deepestSignal: "ws-allowed:sig-mine",
    };
    expect(filterCascadeForUser(evt, wsAccessible)).toEqual(evt);
  });

  it("forwards queue_drained unchanged (pure aggregate, no workspace data)", () => {
    const evt = {
      type: "cascade.queue_drained" as const,
      at: "2026-05-11T00:00:00Z",
      inFlight: 0,
      cap: 10,
    };
    expect(filterCascadeForUser(evt, new Set())).toEqual(evt);
  });

  it("forwards queue_saturated unchanged when deepestSignal is absent", () => {
    const evt = {
      type: "cascade.queue_saturated" as const,
      at: "2026-05-11T00:00:00Z",
      inFlight: 5,
      cap: 10,
      backlog: 1,
    };
    expect(filterCascadeForUser(evt, new Set())).toEqual(evt);
  });
});
