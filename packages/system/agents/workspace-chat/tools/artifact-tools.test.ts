import { beforeEach, describe, expect, it, vi } from "vitest";
import { createArtifactsCreateTool } from "./artifact-tools.ts";

const mockArtifactsCreatePost = vi.hoisted(() => vi.fn<(args: unknown) => Promise<unknown>>());
const mockReadFile = vi.hoisted(() => vi.fn<(path: string) => Promise<Uint8Array>>());

vi.mock("@atlas/client/v2", () => ({
  client: {
    artifactsStorage: {
      index: { $post: mockArtifactsCreatePost },
    },
  },
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

describe("artifacts_create", () => {
  it("infers text/markdown mimeType from .md filename", async () => {
    const tools = createArtifactsCreateTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.artifacts_create!.execute!(
      { path: "SKILL.md", title: "A skill", summary: "A test skill artifact." },
      TOOL_CALL_OPTS,
    );

    expect(mockArtifactsCreatePost).toHaveBeenCalledOnce();
    const call = mockArtifactsCreatePost.mock.calls[0]?.[0] as { json: { data: { mimeType?: string } } };
    expect(call.json.data.mimeType).toBe("text/markdown");
  });

  it("infers text/html mimeType from .html filename (extension outside upload allowlist)", async () => {
    const tools = createArtifactsCreateTool({
      sessionId: "session-1",
      workspaceId: "ws-1",
      streamId: undefined,
    });

    await tools.artifacts_create!.execute!(
      { path: "report.html", title: "A report", summary: "A test HTML artifact." },
      TOOL_CALL_OPTS,
    );

    const call = mockArtifactsCreatePost.mock.calls[0]?.[0] as { json: { data: { mimeType?: string } } };
    expect(call.json.data.mimeType).toBe("text/html");
  });
});
