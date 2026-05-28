import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadChatTool } from "./read-chat.ts";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

type ReadChatInput = { workspace_id: string; chat_id: string; limit?: number };
type ReadChatOutput =
  | {
      ok: true;
      chat: { id: string; title: string | null; workspaceId: string };
      messages: unknown[];
      count: number;
      totalMessageCount: number;
      truncated: boolean;
    }
  | { ok: false; error: string };

function getExecute(): (input: ReadChatInput) => Promise<ReadChatOutput> {
  const tool = createReadChatTool(logger).read_chat;
  if (!tool || typeof tool.execute !== "function") {
    throw new Error("read_chat tool has no execute method");
  }
  const exec = tool.execute as unknown as (input: ReadChatInput) => Promise<ReadChatOutput>;
  return exec;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("read_chat (agent tool)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the chat title and messages on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          chat: { id: "c1", title: "Research notes", workspaceId: "ws-a", userId: "u" },
          messages: [
            { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
            { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
          ],
        }),
      ),
    );

    const result = await getExecute()({ workspace_id: "ws-a", chat_id: "c1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chat).toEqual({ id: "c1", title: "Research notes", workspaceId: "ws-a" });
      expect(result.count).toBe(2);
      expect(result.truncated).toBe(false);
      expect(result.totalMessageCount).toBe(2);
    }
  });

  it("reports truncated when totalMessageCount exceeds returned slice (friday-studio-ns4)", async () => {
    // 5000-message source chat; route trims to 100; tool keeps all 100.
    // Without totalMessageCount the tool would conclude 100 > 100 → false.
    const last100 = Array.from({ length: 100 }, (_, i) => ({
      id: `m${4900 + i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `msg-${4900 + i}` }],
    }));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({
            chat: { id: "c1", title: null, workspaceId: "ws-a", userId: "u" },
            messages: last100,
            totalMessageCount: 5000,
          }),
        ),
    );

    const result = await getExecute()({ workspace_id: "ws-a", chat_id: "c1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBe(100);
      expect(result.totalMessageCount).toBe(5000);
      expect(result.truncated).toBe(true);
    }
  });

  it("returns an error response when the chat is not found (404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "Chat not found" }, 404)),
    );

    const result = await getExecute()({ workspace_id: "ws-a", chat_id: "missing" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/HTTP 404/);
    }
  });
});
