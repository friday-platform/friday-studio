import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.stubGlobal("fetch", mockFetch);
vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

import { __test, liftToolResultsForPersist, scrubAssistantMessage } from "./scrubber.ts";

// Helper: lift a single tool result through the post-stream lift path.
// Replaces the deleted MCP-boundary `createScrubber` (O1, post-N4 cleanup);
// the lift logic is identical, just invoked at the persistence boundary
// (one-call-per-toolName) instead of the per-MCP-call boundary.
async function lift(value: unknown, ctx: typeof TOOL_CTX): Promise<unknown> {
  const out = await liftToolResultsForPersist(
    [{ toolName: ctx.toolName, args: {}, result: value }],
    { workspaceId: "ws", chatId: "ch", logger },
  );
  return out[0]?.result;
}

const { DATA_URL_RE, EMBEDDED_BASE64_RE, SIZE_THRESHOLD_CHARS, TEXT_THRESHOLD_CHARS } = __test;

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
    const envelope = `Attachment downloaded successfully!\n\nBase64 content (${SIZE_THRESHOLD_CHARS} chars, standard base64):\n${bigBase64(
      SIZE_THRESHOLD_CHARS,
    )}\n\nGoodbye.`;
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

describe("post-stream lift (liftToolResultsForPersist)", () => {
  it("passes through small string results untouched", async () => {
    const result = await lift({ content: [{ type: "text", text: "hello world" }] }, TOOL_CTX);
    expect(result).toEqual({ content: [{ type: "text", text: "hello world" }] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("lifts oversized data URL strings to artifacts and replaces with marker", async () => {
    mockArtifactCreate("art_42", 50_000, "image/png");
    const dataUrl = `data:image/png;base64,${bigBase64(SIZE_THRESHOLD_CHARS + 100)}`;
    const result = (await lift(
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
    const blob = bigBase64(SIZE_THRESHOLD_CHARS + 200);
    const text = `Attachment downloaded successfully!\nMessage ID: 123\nSize: 24.4 KB (24942 bytes)\n\nBase64-encoded content:\n${blob}\n\nDone.`;
    const result = (await lift({ content: [{ type: "text", text }] }, TOOL_CTX)) as {
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
    const result = (await lift(
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
    const dataUrl = `data:image/png;base64,${bigBase64(SIZE_THRESHOLD_CHARS + 100)}`;
    const result = (await lift({ content: [{ type: "image", data: dataUrl }] }, TOOL_CTX)) as {
      content: Array<{ type: string; data: string }>;
    };
    expect(result.content[0]?.data).toBe(dataUrl);
  });

  it("dedupes identical base64 within one tool result (FastMCP wrap_result)", async () => {
    // Mock ONE artifact create — if dedup works the second match reuses
    // the first upload's artifactId without hitting the endpoint again.
    mockArtifactCreate("art_dedup", 24_000, "application/pdf");

    const blob = bigBase64(SIZE_THRESHOLD_CHARS + 200);
    // FastMCP shape: same payload in `content[].text` and `structuredContent.result`.
    const result = (await lift(
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
    // Below threshold — no lift, no rewrite.
    const text = `Here's a small chunk: ${bigBase64(SIZE_THRESHOLD_CHARS - 1)} that fits inline.`;
    const result = await lift({ content: [{ type: "text", text }] }, TOOL_CTX);
    expect(result).toEqual({ content: [{ type: "text", text }] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("createScrubber — text/JSON lifting", () => {
  // Padding generator that doesn't look like base64 (avoid colliding with
  // EMBEDDED_BASE64_RE — `A`-only strings would match its character class
  // at threshold and get lifted as binary).
  const lorem = (size: number) =>
    "the quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(size / 45)).slice(0, size);

  it("lifts a 10 KB JSON object with application/json mime", async () => {
    mockArtifactCreate("art_json", 10 * 1024, "application/json");
    // Build a parseable JSON document just above the threshold.
    const body = lorem(200);
    const json = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, body })) });
    expect(json.length).toBeGreaterThanOrEqual(TEXT_THRESHOLD_CHARS);
    const result = (await lift({ content: [{ type: "text", text: json }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/artifact art_json/);
    // Confirm the upload was sent with application/json mime.
    const reqInit = mockFetch.mock.calls[0]?.[1];
    const sentBody = JSON.parse(reqInit?.body as string) as { data: { mimeType: string } };
    expect(sentBody.data.mimeType).toBe("application/json");
  });

  it("lifts a 10 KB HTML page with text/html mime", async () => {
    mockArtifactCreate("art_html", 10 * 1024, "text/html");
    const html = `<!DOCTYPE html>\n<html><body>${lorem(TEXT_THRESHOLD_CHARS + 256)}</body></html>`;
    const result = (await lift({ content: [{ type: "text", text: html }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/artifact art_html/);
    const sentBody = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as {
      data: { mimeType: string };
    };
    expect(sentBody.data.mimeType).toBe("text/html");
  });

  it("lifts a 10 KB markdown document with text/markdown mime", async () => {
    mockArtifactCreate("art_md", 10 * 1024, "text/markdown");
    const md = `# Report\n\n${lorem(TEXT_THRESHOLD_CHARS + 256)}`;
    const result = (await lift({ content: [{ type: "text", text: md }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/artifact art_md/);
    const sentBody = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as {
      data: { mimeType: string };
    };
    expect(sentBody.data.mimeType).toBe("text/markdown");
  });

  it("lifts a 10 KB plain text blob with text/plain mime", async () => {
    mockArtifactCreate("art_txt", 10 * 1024, "text/plain");
    const text = lorem(TEXT_THRESHOLD_CHARS + 1024);
    const result = (await lift({ content: [{ type: "text", text }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/artifact art_txt/);
    const sentBody = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as {
      data: { mimeType: string };
    };
    expect(sentBody.data.mimeType).toBe("text/plain");
  });

  it("lifts a 10 KB CSV blob with text/csv mime", async () => {
    mockArtifactCreate("art_csv", 10 * 1024, "text/csv");
    // 3+ columns, many rows, consistent comma counts — the sniff
    // identifies it as CSV so the artifact + the lift marker carry
    // the right mime, and the dedicated table-view route picks it up
    // when the operator opens it.
    const header = "id,first_name,last_name,city";
    const row = `1,Alice,Smith-Worthington,"Seattle, WA"`;
    const csv = [header, ...Array(300).fill(row)].join("\n");
    expect(csv.length).toBeGreaterThanOrEqual(TEXT_THRESHOLD_CHARS);
    const result = (await lift({ content: [{ type: "text", text: csv }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/artifact art_csv/);
    const sentBody = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as {
      data: { mimeType: string; originalName?: string };
    };
    expect(sentBody.data.mimeType).toBe("text/csv");
    // Synthesized filename should pick up the .csv extension.
    expect(sentBody.data.originalName).toMatch(/\.csv$/);
  });

  it("lifts a 10 KB TSV blob with text/tab-separated-values mime", async () => {
    mockArtifactCreate("art_tsv", 10 * 1024, "text/tab-separated-values");
    const header = "id\tfirst_name\tlast_name\tcity";
    const row = "1\tAlice\tSmith\tSeattle";
    const tsv = [header, ...Array(450).fill(row)].join("\n");
    expect(tsv.length).toBeGreaterThanOrEqual(TEXT_THRESHOLD_CHARS);
    const result = (await lift({ content: [{ type: "text", text: tsv }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/artifact art_tsv/);
    const sentBody = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as {
      data: { mimeType: string; originalName?: string };
    };
    expect(sentBody.data.mimeType).toBe("text/tab-separated-values");
    expect(sentBody.data.originalName).toMatch(/\.tsv$/);
  });

  it("does NOT mistag arbitrary prose with commas as CSV", async () => {
    mockArtifactCreate("art_plain", 10 * 1024, "text/plain");
    // Three-sentence paragraph repeated to threshold. Every sentence
    // carries multiple commas but the comma counts differ wildly per
    // line, so the looksLikeDelimited heuristic rejects.
    const prose = [
      "Once upon a time, in a kingdom far, far away, there lived a baker.",
      "She baked, she sang, she danced.",
      "Every morning, she rose early, prepared dough, and opened her shop.",
    ].join(" ");
    const blob = prose.repeat(Math.ceil(TEXT_THRESHOLD_CHARS / prose.length));
    expect(blob.length).toBeGreaterThanOrEqual(TEXT_THRESHOLD_CHARS);
    const result = (await lift({ content: [{ type: "text", text: blob }] }, TOOL_CTX)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string) as {
      data: { mimeType: string };
    };
    expect(sentBody.data.mimeType).toBe("text/plain");
    expect(result.content[0]?.text).toMatch(/artifact art_plain/);
  });

  it("does NOT lift text below the text threshold", async () => {
    const text = lorem(5 * 1024); // 5 KB — well below 8 KB threshold.
    const result = await lift({ content: [{ type: "text", text }] }, TOOL_CTX);
    expect(result).toEqual({ content: [{ type: "text", text }] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT re-lift an already-lifted refMarker string above threshold", async () => {
    // Marker prefix + arbitrary padding above threshold to prove the
    // length check alone would otherwise trip the text-lift path.
    const marker = `[attachment lifted to artifact art_prev (50 KB, application/pdf, from x/y) — use display_artifact or get_artifact to read]${lorem(TEXT_THRESHOLD_CHARS)}`;
    expect(marker.length).toBeGreaterThanOrEqual(TEXT_THRESHOLD_CHARS);
    const result = await lift({ content: [{ type: "text", text: marker }] }, TOOL_CTX);
    expect(result).toEqual({ content: [{ type: "text", text: marker }] });
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
