import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCreateArtifactTool } from "./artifact-tools.ts";

const mockArtifactsCreatePost = vi.hoisted(() => vi.fn<(args: unknown) => Promise<unknown>>());
const mockReadFile = vi.hoisted(() => vi.fn<(path: string) => Promise<Uint8Array>>());

vi.mock("@atlas/client/v2", () => ({
  client: { artifactsStorage: { index: { $post: mockArtifactsCreatePost } } },
  parseResult: async (p: Promise<unknown>) => {
    await p;
    return { ok: true, data: { artifact: { id: "art-1" } } };
  },
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: mockReadFile };
});

const TOOL_CALL_OPTS = { toolCallId: "test-call", messages: [] as never[] };

beforeEach(() => {
  vi.clearAllMocks();
  mockArtifactsCreatePost.mockResolvedValue({});
  mockReadFile.mockResolvedValue(new TextEncoder().encode("# hello\nmarkdown body"));
});

describe("create_artifact", () => {
  it("infers text/markdown mimeType from .md filename", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.create_artifact?.execute?.(
      { path: "SKILL.md", title: "A skill", summary: "A test skill artifact." },
      TOOL_CALL_OPTS,
    );

    expect(mockArtifactsCreatePost).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          data: expect.objectContaining({ mimeType: "text/markdown" }),
        }),
      }),
    );
  });

  it("infers text/html mimeType from .html filename (extension outside upload allowlist)", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.create_artifact?.execute?.(
      { path: "report.html", title: "A report", summary: "A test HTML artifact." },
      TOOL_CALL_OPTS,
    );

    expect(mockArtifactsCreatePost).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({ data: expect.objectContaining({ mimeType: "text/html" }) }),
      }),
    );
  });

  it("omits mimeType for unknown extensions (storage layer falls back to magic-byte sniff)", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.create_artifact?.execute?.(
      { path: "data.weirdext", title: "A blob", summary: "A test artifact with unknown ext." },
      TOOL_CALL_OPTS,
    );

    const call = mockArtifactsCreatePost.mock.calls[0]?.[0] as
      | { json: { data: Record<string, unknown> } }
      | undefined;
    expect(call?.json.data).not.toHaveProperty("mimeType");
  });

  it("stamps image/svg+xml mimeType for .svg filename so the CSP sandbox applies", async () => {
    // SVG is text-encoded XML and the daemon CSP keys off mimeType.
    // Letting storage fall back to octet-stream loses the sandbox —
    // an attacker-supplied SVG with `<script>` would execute same-origin.
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.create_artifact?.execute?.(
      { path: "icon.svg", title: "An icon", summary: "A test SVG artifact." },
      TOOL_CALL_OPTS,
    );

    expect(mockArtifactsCreatePost).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          data: expect.objectContaining({ mimeType: "image/svg+xml" }),
        }),
      }),
    );
  });

  it("omits mimeType for binary extensions so storage can sniff the bytes", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.create_artifact?.execute?.(
      { path: "image.png", title: "An image", summary: "A test image artifact." },
      TOOL_CALL_OPTS,
    );

    const call = mockArtifactsCreatePost.mock.calls[0]?.[0] as
      | { json: { data: Record<string, unknown> } }
      | undefined;
    expect(call?.json.data).not.toHaveProperty("mimeType");
  });

  it("returns harvester-compatible { id, type, summary } shape on success", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    const result = await tools.create_artifact?.execute?.(
      { path: "SKILL.md", title: "A skill", summary: "A test skill artifact." },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      success: true,
      id: "art-1",
      type: "file",
      summary: "A test skill artifact.",
    });
  });

  it("surfaces scratch-file read failures without throwing", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    const result = await tools.create_artifact?.execute?.(
      { path: "missing.md", title: "Missing", summary: "Should fail to read." },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Failed to read scratch file"),
    });
  });
});

describe("save_artifact", () => {
  it("encodes content as base64 and stamps text-MIME from filename", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.save_artifact?.execute?.(
      {
        filename: "notes.md",
        content: "# hello",
        title: "Notes",
        summary: "Short notes for the test.",
      },
      TOOL_CALL_OPTS,
    );

    expect(mockArtifactsCreatePost).toHaveBeenCalledWith(
      expect.objectContaining({
        json: expect.objectContaining({
          data: expect.objectContaining({
            type: "file",
            contentEncoding: "base64",
            originalName: "notes.md",
            mimeType: "text/markdown",
          }),
        }),
      }),
    );
  });

  it("returns harvester-compatible { id, type, summary } shape on success", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    const result = await tools.save_artifact?.execute?.(
      {
        filename: "data.json",
        content: '{"a":1}',
        title: "Config",
        summary: "Inline JSON payload for the harvester test.",
      },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      success: true,
      id: "art-1",
      type: "file",
      summary: "Inline JSON payload for the harvester test.",
    });
  });

  it("rejects filenames with binary MIME (sandbox-escape via fake png)", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    const result = await tools.save_artifact?.execute?.(
      {
        filename: "chart.png",
        content: "iVBORw0KGgo...not actually a PNG...",
        title: "Fake PNG",
        summary: "Model put base64 into the content string by mistake.",
      },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("does not resolve to a known text MIME"),
    });
    expect(mockArtifactsCreatePost).not.toHaveBeenCalled();
  });

  it("rejects filenames with unknown extensions (.zip, .exe, etc. that aren't in the MIME table)", async () => {
    // Description and SKILL.md both promise that binary-looking filenames
    // are rejected. The MIME table only knows the curated text extensions,
    // so "unknown extension" must also reject (otherwise .zip/.exe leak
    // through silently because they have no MIME entry).
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    for (const filename of ["archive.zip", "binary.exe", "blob.weirdext"]) {
      const result = await tools.save_artifact?.execute?.(
        {
          filename,
          content: "irrelevant",
          title: "Test",
          summary: "Unknown extension should be rejected.",
        },
        TOOL_CALL_OPTS,
      );
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("does not resolve to a known text MIME"),
      });
    }
    expect(mockArtifactsCreatePost).not.toHaveBeenCalled();
  });

  it("rejects path-traversal in filename via resolveInScratch", async () => {
    const tools = createCreateArtifactTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    const result = await tools.save_artifact?.execute?.(
      {
        filename: "../escape.md",
        content: "x",
        title: "Escape",
        summary: "Attempt to write outside the scratch dir.",
      },
      TOOL_CALL_OPTS,
    );

    expect(result).toMatchObject({ success: false });
    expect(mockArtifactsCreatePost).not.toHaveBeenCalled();
  });
});
