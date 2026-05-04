import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.stubGlobal("fetch", mockFetch);
vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

import { __test, createScrubber, scrubAssistantMessage } from "./scrub-tool-output.ts";

const { DATA_URL_RE, EMBEDDED_BASE64_RE, SIZE_THRESHOLD_CHARS } = __test;

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const TOOL_CTX = { serverId: "google-gmail", toolName: "get_gmail_attachment_content" };

beforeEach(() => {
  mockFetch.mockReset();
});

function bigBase64(chars: number): string {
  // Pure base64-looking content of the requested length.
  return "A".repeat(chars);
}

function mockArtifactCreate(artifactId: string, size: number, mimeType: string) {
  return mockFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        artifact: {
          id: artifactId,
          type: "file",
          revision: 1,
          data: { type: "file", contentRef: "abc", size, mimeType },
          title: "x",
          summary: "y",
          createdAt: new Date().toISOString(),
        },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ),
  );
}

describe("EMBEDDED_BASE64_RE", () => {
  it("matches a pure base64 run at threshold", () => {
    EMBEDDED_BASE64_RE.lastIndex = 0;
    expect(EMBEDDED_BASE64_RE.exec(bigBase64(SIZE_THRESHOLD_CHARS))).not.toBeNull();
  });

  it("rejects a base64 run shorter than threshold", () => {
    EMBEDDED_BASE64_RE.lastIndex = 0;
    expect(EMBEDDED_BASE64_RE.exec(bigBase64(SIZE_THRESHOLD_CHARS - 1))).toBeNull();
  });

  it("matches base64 embedded inside a larger envelope", () => {
    const envelope = `Attachment downloaded successfully!\n\nBase64 content (${SIZE_THRESHOLD_CHARS} chars, standard base64):\n${bigBase64(SIZE_THRESHOLD_CHARS)}\n\nGoodbye.`;
    EMBEDDED_BASE64_RE.lastIndex = 0;
    const m = EMBEDDED_BASE64_RE.exec(envelope);
    expect(m).not.toBeNull();
    expect(m?.[0].length).toBe(SIZE_THRESHOLD_CHARS);
  });
});

describe("DATA_URL_RE", () => {
  it("captures mime + body from a basic data URL", () => {
    const m = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA".match(DATA_URL_RE);
    expect(m?.[1]).toBe("image/png");
    expect(m?.[2]).toBe("iVBORw0KGgoAAAANSUhEUgAA");
  });

  it("rejects URLs without the base64 marker", () => {
    expect("data:image/png,not-base64".match(DATA_URL_RE)).toBeNull();
  });
});

describe("createScrubber (MCP-boundary)", () => {
  it("passes through small string results untouched", async () => {
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const result = await scrub({ content: [{ type: "text", text: "hello world" }] }, TOOL_CTX);
    expect(result).toEqual({ content: [{ type: "text", text: "hello world" }] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("lifts oversized data URL strings to artifacts and replaces with marker", async () => {
    mockArtifactCreate("art_42", 50_000, "image/png");
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const dataUrl = `data:image/png;base64,${bigBase64(SIZE_THRESHOLD_CHARS + 100)}`;
    const result = (await scrub(
      { content: [{ type: "image", data: dataUrl, mimeType: "image/png" }] },
      TOOL_CTX,
    )) as { content: Array<{ type: string; data: string; mimeType: string }> };

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.data).toMatch(/artifact art_42/);
    expect(result.content[0]?.data).toMatch(/display_artifact/);
    expect(result.content[0]?.type).toBe("image");
    expect(result.content[0]?.mimeType).toBe("image/png");
  });

  it("lifts a base64 block embedded inside a Gmail-style envelope", async () => {
    mockArtifactCreate("art_pdf", 24_000, "application/pdf");
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const blob = bigBase64(SIZE_THRESHOLD_CHARS + 200);
    const text = `Attachment downloaded successfully!\nMessage ID: 123\nSize: 24.4 KB (24942 bytes)\n\nBase64-encoded content:\n${blob}\n\nDone.`;
    const result = (await scrub({ content: [{ type: "text", text }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const out = result.content[0]?.text ?? "";
    expect(out).toContain("Attachment downloaded successfully!");
    expect(out).toContain("Done.");
    expect(out).toMatch(/artifact art_pdf/);
    // The original blob should be gone from the rewritten string.
    expect(out).not.toContain(blob);
  });

  it("recurses into nested objects and arrays", async () => {
    mockArtifactCreate("art_1", 100_000, "application/pdf");
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const result = (await scrub(
      {
        outer: {
          attachments: [{ name: "summary.pdf", body: bigBase64(SIZE_THRESHOLD_CHARS + 100) }],
        },
      },
      TOOL_CTX,
    )) as { outer: { attachments: Array<{ name: string; body: string }> } };

    expect(result.outer.attachments[0]?.name).toBe("summary.pdf");
    expect(result.outer.attachments[0]?.body).toMatch(/artifact art_1/);
  });

  it("returns original value if upload fails", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const dataUrl = `data:image/png;base64,${bigBase64(SIZE_THRESHOLD_CHARS + 100)}`;
    const result = (await scrub({ content: [{ type: "image", data: dataUrl }] }, TOOL_CTX)) as {
      content: Array<{ type: string; data: string }>;
    };
    expect(result.content[0]?.data).toBe(dataUrl);
  });

  it("dedupes identical base64 within one tool result (FastMCP wrap_result)", async () => {
    // Mock ONE artifact create — if dedup works the second match reuses
    // the first upload's artifactId without hitting the endpoint again.
    mockArtifactCreate("art_dedup", 24_000, "application/pdf");

    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const blob = bigBase64(SIZE_THRESHOLD_CHARS + 200);
    // FastMCP shape: same payload in `content[].text` and `structuredContent.result`.
    const result = (await scrub(
      {
        _meta: { fastmcp: { wrap_result: true } },
        content: [{ type: "text", text: `prefix ${blob} suffix` }],
        structuredContent: { result: `prefix ${blob} suffix` },
        isError: false,
      },
      TOOL_CTX,
    )) as { content: Array<{ type: string; text: string }>; structuredContent: { result: string } };

    // Only one upload should have happened.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // Both copies got the same marker (so the model can still see the ref).
    expect(result.content[0]?.text).toMatch(/artifact art_dedup/);
    expect(result.structuredContent.result).toMatch(/artifact art_dedup/);
  });

  it("leaves short base64 fragments alone", async () => {
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    // Below threshold — no lift, no rewrite.
    const text = `Here's a small chunk: ${bigBase64(SIZE_THRESHOLD_CHARS - 1)} that fits inline.`;
    const result = await scrub({ content: [{ type: "text", text }] }, TOOL_CTX);
    expect(result).toEqual({ content: [{ type: "text", text }] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("scrubAssistantMessage (pre-persist)", () => {
  it("scrubs tool-call output", async () => {
    mockArtifactCreate("art_out", 32_000, "application/pdf");
    const parts: Array<Record<string, unknown>> = [
      { type: "step-start" },
      {
        type: "tool-get_gmail_attachment_content",
        toolCallId: "t1",
        state: "output-available",
        input: { message_id: "m1" },
        output: {
          content: [
            { type: "text", text: `prefix ${bigBase64(SIZE_THRESHOLD_CHARS + 50)} suffix` },
          ],
        },
      },
    ];
    const r = await scrubAssistantMessage(parts, { workspaceId: "ws", chatId: "ch", logger });
    expect(r.rewritten).toBe(1);
    const out = (parts[1] as { output: { content: Array<{ text: string }> } }).output;
    expect(out.content[0]?.text).toMatch(/artifact art_out/);
  });

  it("scrubs tool-call input — catches model-embedded base64 in run_code", async () => {
    mockArtifactCreate("art_in", 24_000, "application/pdf");
    const blob = bigBase64(SIZE_THRESHOLD_CHARS + 200);
    const parts: Array<Record<string, unknown>> = [
      {
        type: "tool-run_code",
        toolCallId: "t2",
        state: "input-streaming",
        input: { language: "python", source: `b64 = "${blob}"\nprint(b64[:10])` },
      },
    ];
    const r = await scrubAssistantMessage(parts, { workspaceId: "ws", chatId: "ch", logger });
    expect(r.rewritten).toBe(1);
    const inp = (parts[0] as { input: { source: string } }).input;
    expect(inp.source).toMatch(/artifact art_in/);
    expect(inp.source).not.toContain(blob);
  });

  it("scrubs delegate-chunk envelopes", async () => {
    mockArtifactCreate("art_delegate", 16_000, "application/pdf");
    const parts: Array<Record<string, unknown>> = [
      {
        type: "data-delegate-chunk",
        data: {
          delegateToolCallId: "del1",
          chunk: {
            type: "tool-output-available",
            output: {
              content: [{ type: "text", text: `oh ${bigBase64(SIZE_THRESHOLD_CHARS + 50)} hi` }],
            },
          },
        },
      },
    ];
    const r = await scrubAssistantMessage(parts, { workspaceId: "ws", chatId: "ch", logger });
    expect(r.rewritten).toBe(1);
    const chunk = (
      parts[0] as { data: { chunk: { output: { content: Array<{ text: string }> } } } }
    ).data.chunk;
    expect(chunk.output.content[0]?.text).toMatch(/artifact art_delegate/);
  });

  it("leaves clean messages untouched", async () => {
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: "hello" },
      {
        type: "tool-write_file",
        toolCallId: "t3",
        state: "output-available",
        input: { path: "x.md", content: "small file" },
        output: { ok: true },
      },
    ];
    const r = await scrubAssistantMessage(parts, { workspaceId: "ws", chatId: "ch", logger });
    expect(r.rewritten).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
