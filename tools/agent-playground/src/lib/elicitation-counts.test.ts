import { describe, expect, it } from "vitest";
import type { Elicitation } from "@atlas/core/elicitations/model";
import {
  countPendingElicitations,
  effectiveElicitationStatus,
} from "./elicitation-counts.ts";

function makeElicitation(overrides: Partial<Elicitation>): Elicitation {
  const now = new Date("2026-05-07T00:00:00.000Z").toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    workspaceId: overrides.workspaceId ?? "ws-1",
    sessionId: overrides.sessionId ?? "session-1",
    kind: overrides.kind ?? "tool-allowlist",
    question: overrides.question ?? "Allow tool?",
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? now,
    expiresAt: overrides.expiresAt ?? "2026-05-07T00:01:00.000Z",
    ...(overrides.actionId ? { actionId: overrides.actionId } : {}),
    ...(overrides.pendingTool ? { pendingTool: overrides.pendingTool } : {}),
    ...(overrides.options ? { options: overrides.options } : {}),
    ...(overrides.answer ? { answer: overrides.answer } : {}),
  };
}

describe("elicitation counts", () => {
  const nowMs = Date.parse("2026-05-07T00:00:30.000Z");

  it("treats past-deadline pending entries as expired", () => {
    const elicitation = makeElicitation({
      expiresAt: "2026-05-07T00:00:00.000Z",
    });

    expect(effectiveElicitationStatus(elicitation, nowMs)).toBe("expired");
  });

  it("counts only active pending entries", () => {
    const elicitations = [
      makeElicitation({ id: "pending", status: "pending" }),
      makeElicitation({ id: "answered", status: "answered" }),
      makeElicitation({ id: "declined", status: "declined" }),
      makeElicitation({
        id: "expired",
        status: "pending",
        expiresAt: "2026-05-07T00:00:00.000Z",
      }),
    ];

    expect(countPendingElicitations(elicitations, nowMs)).toBe(1);
  });

  it("can count pending entries for one workspace", () => {
    const elicitations = [
      makeElicitation({ id: "ws-1-a", workspaceId: "ws-1" }),
      makeElicitation({ id: "ws-2-a", workspaceId: "ws-2" }),
      makeElicitation({
        id: "ws-1-old",
        workspaceId: "ws-1",
        status: "answered",
      }),
    ];

    expect(countPendingElicitations(elicitations, nowMs, "ws-1")).toBe(1);
    expect(countPendingElicitations(elicitations, nowMs, "ws-2")).toBe(1);
  });
});
