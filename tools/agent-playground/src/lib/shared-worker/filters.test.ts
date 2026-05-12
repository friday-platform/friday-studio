/**
 * Unit tests for the worker's per-channel frame filter. These cover the
 * boundary the daemon's `/api/me/stream` route ends and the page-side
 * fanout begins.
 */

import { describe, expect, it } from "vitest";
import { matches } from "./filters.ts";
import type { UpstreamFrame } from "./protocol.ts";

const frame = (overrides: Partial<UpstreamFrame> & Pick<UpstreamFrame, "kind" | "subject">): UpstreamFrame => ({
  payload: {},
  ...overrides,
});

describe("matches", () => {
  describe("cascade", () => {
    it("accepts instance.cascade.* frames", () => {
      expect(
        matches(frame({ kind: "instance", subject: "instance.cascade.queue_saturated" }), {
          channel: "cascade",
        }),
      ).toBe(true);
      expect(
        matches(frame({ kind: "instance", subject: "instance.cascade.queue_drained" }), {
          channel: "cascade",
        }),
      ).toBe(true);
    });

    it("rejects non-cascade instance frames", () => {
      expect(
        matches(frame({ kind: "instance", subject: "instance.daemon.bootstrap" }), {
          channel: "cascade",
        }),
      ).toBe(false);
    });

    it("rejects elicitation and workspace-event frames", () => {
      expect(
        matches(frame({ kind: "elicitation", subject: "elicitations.ws.s.e", workspaceId: "ws" }), {
          channel: "cascade",
        }),
      ).toBe(false);
    });
  });

  describe("global-elicitations", () => {
    it("accepts every elicitation frame regardless of workspace", () => {
      expect(
        matches(
          frame({ kind: "elicitation", workspaceId: "ws-a", subject: "elicitations.ws-a.s.e" }),
          { channel: "global-elicitations" },
        ),
      ).toBe(true);
      expect(
        matches(
          frame({ kind: "elicitation", workspaceId: "ws-b", subject: "elicitations.ws-b.s.e" }),
          { channel: "global-elicitations" },
        ),
      ).toBe(true);
    });

    it("rejects non-elicitation frames", () => {
      expect(
        matches(frame({ kind: "workspace-event", subject: "events.ws.foo", workspaceId: "ws" }), {
          channel: "global-elicitations",
        }),
      ).toBe(false);
    });
  });

  describe("workspace-elicitations", () => {
    it("accepts elicitations only for the named workspace", () => {
      const params = { channel: "workspace-elicitations" as const, workspaceId: "ws-mine" };
      expect(
        matches(
          frame({ kind: "elicitation", workspaceId: "ws-mine", subject: "elicitations.ws-mine.s.e" }),
          params,
        ),
      ).toBe(true);
      expect(
        matches(
          frame({ kind: "elicitation", workspaceId: "ws-other", subject: "elicitations.ws-other.s.e" }),
          params,
        ),
      ).toBe(false);
    });
  });

  describe("schedule-events", () => {
    it("accepts events.<ws>.schedule.* frames", () => {
      expect(
        matches(
          frame({
            kind: "workspace-event",
            subject: "events.ws-1.schedule.missed",
            workspaceId: "ws-1",
          }),
          { channel: "schedule-events" },
        ),
      ).toBe(true);
    });

    it("rejects non-schedule workspace events", () => {
      expect(
        matches(
          frame({
            kind: "workspace-event",
            subject: "events.ws-1.signal.failed",
            workspaceId: "ws-1",
          }),
          { channel: "schedule-events" },
        ),
      ).toBe(false);
    });
  });

  describe("session-events", () => {
    it("never matches a firehose frame (deferred to legacy SSE)", () => {
      expect(
        matches(
          frame({ kind: "workspace-event", subject: "events.ws.session.update", workspaceId: "ws" }),
          { channel: "session-events", sessionId: "sess-1" },
        ),
      ).toBe(false);
    });
  });
});
