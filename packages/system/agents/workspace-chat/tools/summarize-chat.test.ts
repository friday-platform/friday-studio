import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSummarizeChatTool } from "./summarize-chat.ts";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

type SummarizeInput = { workspace_id: string; chat_id: string; focus?: string };
type SummarizeOutput =
  | {
      ok: true;
      summary: string;
      messageCount: number;
      modelId: string;
      generatedAt: string;
      cached: boolean;
    }
  | { ok: false; error: string };

function getExecute(): (input: SummarizeInput) => Promise<SummarizeOutput> {
  const tool = createSummarizeChatTool(logger).summarize_chat;
  if (!tool || typeof tool.execute !== "function") {
    throw new Error("summarize_chat tool has no execute method");
  }
  return tool.execute as unknown as (input: SummarizeInput) => Promise<SummarizeOutput>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("summarize_chat (agent tool)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the summary payload on success and POSTs focus in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        summary: "Decisions: ship today.",
        messageCount: 42,
        modelId: "claude-haiku-4-5",
        generatedAt: "2026-05-22T00:00:00.000Z",
        cached: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getExecute()({
      workspace_id: "ws-a",
      chat_id: "c1",
      focus: "decisions",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary).toContain("ship today");
      expect(result.messageCount).toBe(42);
      expect(result.cached).toBe(false);
    }
    // Verify POST + focus in body
    const call = fetchMock.mock.calls[0];
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ focus: "decisions" });
  });

  it("flags cache hits via the cached field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          summary: "from cache",
          messageCount: 4,
          modelId: "stub",
          generatedAt: "2026-05-20T00:00:00.000Z",
          cached: true,
        }),
      ),
    );

    const result = await getExecute()({ workspace_id: "ws-a", chat_id: "c1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cached).toBe(true);
  });

  it("returns an error response when the chat is not found (404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Chat not found" }, 404)),
    );

    const result = await getExecute()({ workspace_id: "ws-a", chat_id: "missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/HTTP 404/);
  });
});
