import type { Elicitation, ElicitationSummary } from "@atlas/core/elicitations/model";
import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/svelte-query", async () => {
  const core = await import("@tanstack/query-core");
  return {
    ...core,
    createMutation: vi.fn(),
    queryOptions: <T>(options: T) => options,
    useQueryClient: vi.fn(),
  };
});

const { applyElicitationSummaryEvent, elicitationListKey } = await import(
  "./elicitation-queries.ts"
);

function makeElicitation(overrides: Partial<Elicitation> = {}): Elicitation {
  return {
    id: overrides.id ?? "elc_1",
    workspaceId: overrides.workspaceId ?? "ws_1",
    sessionId: overrides.sessionId ?? "sess_1",
    kind: overrides.kind ?? "open-question",
    question: overrides.question ?? "Continue?",
    createdAt: overrides.createdAt ?? "2026-05-05T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-05-05T01:00:00.000Z",
    status: overrides.status ?? "pending",
    ...(overrides.actionId ? { actionId: overrides.actionId } : {}),
    ...(overrides.options ? { options: overrides.options } : {}),
    ...(overrides.pendingTool ? { pendingTool: overrides.pendingTool } : {}),
    ...(overrides.answer ? { answer: overrides.answer } : {}),
  };
}

describe("elicitation query cache helpers", () => {
  it("summary events patch safe fields and preserve sensitive full details", () => {
    const queryClient = new QueryClient();
    const full = makeElicitation({
      question: "Sensitive question?",
      pendingTool: { name: "send_email", args: { body: "private" } },
    });
    queryClient.setQueryData<Elicitation[]>(elicitationListKey(null), [full]);
    queryClient.setQueryData<Elicitation[]>(elicitationListKey("ws_1"), [full]);

    const summary: ElicitationSummary = {
      id: "elc_1",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      kind: "open-question",
      createdAt: "2026-05-05T00:00:00.000Z",
      expiresAt: "2026-05-05T01:00:00.000Z",
      status: "answered",
    };

    applyElicitationSummaryEvent(queryClient, summary);

    const global = queryClient.getQueryData<Elicitation[]>(elicitationListKey(null));
    const scoped = queryClient.getQueryData<Elicitation[]>(elicitationListKey("ws_1"));
    expect(global?.[0]).toMatchObject({
      id: "elc_1",
      status: "answered",
      question: "Sensitive question?",
      pendingTool: { name: "send_email", args: { body: "private" } },
    });
    expect(scoped?.[0]?.status).toBe("answered");
    expect(queryClient.getQueryState(elicitationListKey(null))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(elicitationListKey("ws_1"))?.isInvalidated).toBe(true);
  });
});
