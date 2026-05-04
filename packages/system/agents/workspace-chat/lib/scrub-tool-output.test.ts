import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.stubGlobal("fetch", mockFetch);
vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

import { __test, createScrubber } from "./scrub-tool-output.ts";

const { looksLikeBase64, DATA_URL_RE, SIZE_THRESHOLD_CHARS } = __test;

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

describe("looksLikeBase64", () => {
  it("rejects short strings under threshold", () => {
    expect(looksLikeBase64(bigBase64(SIZE_THRESHOLD_CHARS - 1))).toBe(false);
  });

  it("accepts long pure-base64 strings at threshold", () => {
    expect(looksLikeBase64(bigBase64(SIZE_THRESHOLD_CHARS))).toBe(true);
  });

  it("rejects long strings with prose mixed in", () => {
    const s = `${bigBase64(100)} The PDF is shown below. ${bigBase64(SIZE_THRESHOLD_CHARS)}`;
    expect(looksLikeBase64(s)).toBe(false);
  });

  it("rejects long human-language text even if length is over threshold", () => {
    // Synthesize a long English paragraph; punctuation breaks the base64 class.
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    expect(looksLikeBase64(sentence.repeat(2000))).toBe(false);
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

describe("createScrubber", () => {
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
    // Other fields preserved.
    expect(result.content[0]?.type).toBe("image");
    expect(result.content[0]?.mimeType).toBe("image/png");
  });

  it("lifts oversized standalone base64 to artifacts", async () => {
    mockArtifactCreate("art_99", 48_000, "application/octet-stream");
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const result = (await scrub(
      { content: [{ type: "text", text: bigBase64(SIZE_THRESHOLD_CHARS + 100) }] },
      TOOL_CTX,
    )) as { content: Array<{ type: string; text: string }> };

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toMatch(/artifact art_99/);
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

  it("leaves prose-with-base64-fragment alone", async () => {
    const scrub = createScrubber({ workspaceId: "ws", chatId: "ch", logger });
    const text = `The attachment data is: ${bigBase64(200)} but here's some explanation text after it that breaks the base64 character class.`;
    const result = await scrub({ content: [{ type: "text", text }] }, TOOL_CTX);
    expect(result).toEqual({ content: [{ type: "text", text }] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
