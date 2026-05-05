import type { Logger } from "@atlas/logger";
import { extractArchiveContents } from "@atlas/skills/archive";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.hoisted(() =>
  vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
);

vi.stubGlobal("fetch", mockFetch);
vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

import { createPublishSkillTool } from "./publish-skill.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const OPTS = { toolCallId: "tc-1", messages: [], abortSignal: new AbortController().signal };

beforeEach(() => {
  mockFetch.mockReset();
});

describe("publish_skill", () => {
  it("POSTs multipart upload to daemon and returns success on 201", async () => {
    const namespace = "tempest";
    const name = "demo-skill";
    const content =
      "---\nname: demo-skill\ndescription: A demo skill. Use when testing.\n---\n\n# Demo\n\nBody.";

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          published: {
            id: "id1",
            skillId: "sk1",
            namespace: "tempest",
            name: "demo-skill",
            version: 1,
          },
        }),
        { status: 201 },
      ),
    );

    const { publish_skill } = createPublishSkillTool(logger);
    const result = await publish_skill!.execute!({ namespace, name, content }, OPTS);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/api/skills/@tempest/demo-skill/upload");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);

    const formData = init.body as FormData;
    const archive = formData.get("archive");
    expect(archive).toBeInstanceOf(Blob);
    expect((archive as Blob).size).toBeGreaterThan(0);
    expect(formData.get("skillMd")).toBe(content);

    expect(result).toEqual({
      success: true,
      skill: { ref: "@tempest/demo-skill", skillId: "sk1", version: 1 },
    });
  });

  it("packs files[] entries into the tar archive at their requested paths", async () => {
    const namespace = "tempest";
    const name = "demo-skill";
    const content =
      "---\nname: demo-skill\ndescription: A demo skill. Use when testing.\n---\n\nMain body.";
    const files = [
      { path: "REFERENCE.md", content: "# Reference\n\nDetailed docs." },
      { path: "scripts/build.sh", content: "#!/bin/sh\necho hi" },
    ];

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          published: {
            id: "id1",
            skillId: "sk1",
            namespace: "tempest",
            name: "demo-skill",
            version: 1,
          },
        }),
        { status: 201 },
      ),
    );

    const { publish_skill } = createPublishSkillTool(logger);
    await publish_skill!.execute!({ namespace, name, content, files }, OPTS);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const formData = init.body as FormData;
    const archive = formData.get("archive") as Blob;
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const contents = await extractArchiveContents(bytes);

    expect(Object.keys(contents).sort()).toEqual(
      ["REFERENCE.md", "SKILL.md", "scripts/build.sh"].sort(),
    );
    expect(contents["SKILL.md"]).toBe(content);
    expect(contents["REFERENCE.md"]).toBe("# Reference\n\nDetailed docs.");
    expect(contents["scripts/build.sh"]).toBe("#!/bin/sh\necho hi");
  });

  it("returns structured failure when fetch rejects with a network error", async () => {
    const namespace = "tempest";
    const name = "demo-skill";
    const content = "---\nname: demo-skill\ndescription: Test. Use when X.\n---\n\nBody.";

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const { publish_skill } = createPublishSkillTool(logger);
    const result = await publish_skill!.execute!({ namespace, name, content }, OPTS);

    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(result).not.toHaveProperty("deadLinks");
  });

  it("returns structured failure with deadLinks when daemon rejects with 400", async () => {
    const namespace = "tempest";
    const name = "demo-skill";
    const content =
      "---\nname: demo-skill\ndescription: Test. Use when X.\n---\n\nSee [docs](MISSING.md) and [more](OTHER.md).";

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Skill instructions reference files not found in archive: MISSING.md, OTHER.md",
          deadLinks: ["MISSING.md", "OTHER.md"],
        }),
        { status: 400 },
      ),
    );

    const { publish_skill } = createPublishSkillTool(logger);
    const result = await publish_skill!.execute!({ namespace, name, content }, OPTS);

    expect(result).toEqual({
      success: false,
      error: "Skill instructions reference files not found in archive: MISSING.md, OTHER.md",
      deadLinks: ["MISSING.md", "OTHER.md"],
    });
  });

  it("returns HTTP status and body when daemon rejects with non-JSON", async () => {
    const content = "---\nname: demo-skill\ndescription: Test. Use when X.\n---\n\nBody.";

    mockFetch.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));

    const { publish_skill } = createPublishSkillTool(logger);
    const result = await publish_skill!.execute!(
      { namespace: "tempest", name: "demo-skill", content },
      OPTS,
    );

    expect(result).toEqual({
      success: false,
      error: "publish_skill failed with status 502: bad gateway",
    });
  });

  it("returns local validation errors without calling fetch", async () => {
    const content = "---\nname: demo-skill\ndescription: Test. Use when X.\n---\n\nBody.";

    const { publish_skill } = createPublishSkillTool(logger);
    const result = await publish_skill!.execute!(
      {
        namespace: "tempest",
        name: "demo-skill",
        content,
        files: [{ path: "././SKILL.md", content: "bad" }],
      },
      OPTS,
    );

    expect(result).toEqual({
      success: false,
      error: "publish_skill failed: SKILL.md is reserved for the canonical skill instructions",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
