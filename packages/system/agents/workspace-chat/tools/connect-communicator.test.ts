import { describe, expect, it } from "vitest";
import { createConnectCommunicatorTool } from "./connect-communicator.ts";

const OPTS = { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal };

describe("connect_communicator tool", () => {
  it("returns kind + active progress on telegram", async () => {
    const tool = createConnectCommunicatorTool();
    const result = await tool.execute!({ kind: "telegram" }, OPTS);
    expect(result).toEqual({
      kind: "telegram",
      progress: { label: "Connecting Telegram", status: "active" },
    });
  });

  it("returns display name in progress label for each kind", async () => {
    const tool = createConnectCommunicatorTool();
    const cases = [
      ["slack", "Connecting Slack"],
      ["telegram", "Connecting Telegram"],
      ["discord", "Connecting Discord"],
      ["teams", "Connecting Microsoft Teams"],
      ["whatsapp", "Connecting WhatsApp"],
    ] as const;
    for (const [kind, expected] of cases) {
      const result = await tool.execute!({ kind }, OPTS);
      expect(result).toMatchObject({ kind, progress: { label: expected, status: "active" } });
    }
  });
});
