import { SkillStorage } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillTool } from "./create-skill.ts";

// =============================================================================
// Test Fixtures
// =============================================================================

const validSkillDraftArtifact = {
  artifact: {
    id: "artifact-123",
    type: "skill-draft" as const,
    revision: 1,
    title: "Test Skill Draft",
    summary: "A test skill",
    createdAt: "2024-01-01T00:00:00Z",
    workspaceId: "ws-123",
    data: {
      type: "skill-draft" as const,
      version: 1 as const,
      data: {
        name: "test-skill",
        description: "A skill for testing",
        instructions: "# Instructions\n\nDo the thing.",
        workspaceId: "ws-123",
      },
    },
  },
};

const wrongTypeArtifact = {
  artifact: {
    id: "artifact-456",
    type: "summary" as const,
    revision: 1,
    title: "Not a skill",
    summary: "Just a summary",
    createdAt: "2024-01-01T00:00:00Z",
    data: {
      type: "summary" as const,
      version: 1 as const,
      data: "This is a summary, not a skill draft",
    },
  },
};

const invalidSkillDraftArtifact = {
  artifact: {
    id: "artifact-789",
    type: "skill-draft" as const,
    revision: 1,
    title: "Invalid Skill Draft",
    summary: "Invalid data",
    createdAt: "2024-01-01T00:00:00Z",
    data: {
      type: "skill-draft" as const,
      version: 1 as const,
      data: {
        // Missing required fields
        name: "",
        description: "",
        instructions: "",
        workspaceId: "",
      },
    },
  },
};

const createdSkill = {
  id: "skill-001",
  name: "test-skill",
  description: "A skill for testing",
  instructions: "# Instructions\n\nDo the thing.",
  workspaceId: "ws-123",
  createdBy: "user-123",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
};

// =============================================================================
// Mock Helpers
// =============================================================================

let originalFetch: typeof fetch;
let originalSkillStorageCreate: typeof SkillStorage.create;

function mockArtifactFetch(
  artifactId: string,
  response: { status: number; data?: unknown; error?: string },
): void {
  globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    // Match artifact storage endpoint
    if (url.includes(`/api/artifacts/${artifactId}`)) {
      if (response.status === 200) {
        return Promise.resolve(
          new Response(JSON.stringify(response.data), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: response.error }), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
  };
}

function mockSkillStorageCreate(
  result: { ok: true; data: typeof createdSkill } | { ok: false; error: string },
): void {
  SkillStorage.create = () => Promise.resolve(result);
}

// =============================================================================
// Tests
// =============================================================================

describe("createSkillTool", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSkillStorageCreate = SkillStorage.create;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    SkillStorage.create = originalSkillStorageCreate;
  });

  it("successfully creates skill from valid draft artifact", async () => {
    mockArtifactFetch("artifact-123", { status: 200, data: validSkillDraftArtifact });
    mockSkillStorageCreate({ ok: true, data: createdSkill });

    // biome-ignore lint/style/noNonNullAssertion: createSkillTool always provides execute
    const result = await createSkillTool.execute!(
      { artifactId: "artifact-123", createdBy: "user-123" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    // Result is never AsyncIterable for this tool
    if (Symbol.asyncIterator in result) throw new Error("Unexpected async iterable");

    expect(result.success).toBe(true);
    if (result.success) {
      // biome-ignore lint/style/noNonNullAssertion: success=true guarantees skill is defined
      expect(result.skill!.id).toBe("skill-001");
      // biome-ignore lint/style/noNonNullAssertion: success=true guarantees skill is defined
      expect(result.skill!.name).toBe("test-skill");
      // biome-ignore lint/style/noNonNullAssertion: success=true guarantees skill is defined
      expect(result.skill!.description).toBe("A skill for testing");
      // biome-ignore lint/style/noNonNullAssertion: success=true guarantees skill is defined
      expect(result.skill!.workspaceId).toBe("ws-123");
    }
  });

  it("returns error if draft artifact not found", async () => {
    mockArtifactFetch("nonexistent", { status: 404, error: "Not found" });

    // biome-ignore lint/style/noNonNullAssertion: createSkillTool always provides execute
    const result = await createSkillTool.execute!(
      { artifactId: "nonexistent", createdBy: "user-123" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    // Result is never AsyncIterable for this tool
    if (Symbol.asyncIterator in result) throw new Error("Unexpected async iterable");

    expect(result.success).toBe(false);
    if (!result.success) {
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("Artifact not found")).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("nonexistent")).toBe(true);
    }
  });

  it("returns error if artifact type is not skill-draft", async () => {
    mockArtifactFetch("artifact-456", { status: 200, data: wrongTypeArtifact });

    // biome-ignore lint/style/noNonNullAssertion: createSkillTool always provides execute
    const result = await createSkillTool.execute!(
      { artifactId: "artifact-456", createdBy: "user-123" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    // Result is never AsyncIterable for this tool
    if (Symbol.asyncIterator in result) throw new Error("Unexpected async iterable");

    expect(result.success).toBe(false);
    if (!result.success) {
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("artifact-456")).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("summary")).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("skill-draft")).toBe(true);
    }
  });

  it("returns error if skill draft data is invalid", async () => {
    mockArtifactFetch("artifact-789", { status: 200, data: invalidSkillDraftArtifact });

    // biome-ignore lint/style/noNonNullAssertion: createSkillTool always provides execute
    const result = await createSkillTool.execute!(
      { artifactId: "artifact-789", createdBy: "user-123" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    // Result is never AsyncIterable for this tool
    if (Symbol.asyncIterator in result) throw new Error("Unexpected async iterable");

    expect(result.success).toBe(false);
    if (!result.success) {
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("Invalid skill draft data")).toBe(true);
    }
  });

  it("returns error if skill already exists (duplicate name)", async () => {
    mockArtifactFetch("artifact-123", { status: 200, data: validSkillDraftArtifact });
    mockSkillStorageCreate({ ok: false, error: "Skill with name 'test-skill' already exists" });

    // biome-ignore lint/style/noNonNullAssertion: createSkillTool always provides execute
    const result = await createSkillTool.execute!(
      { artifactId: "artifact-123", createdBy: "user-123" },
      { toolCallId: "test", messages: [], abortSignal: undefined },
    );

    // Result is never AsyncIterable for this tool
    if (Symbol.asyncIterator in result) throw new Error("Unexpected async iterable");

    expect(result.success).toBe(false);
    if (!result.success) {
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("Failed to create skill")).toBe(true);
      // biome-ignore lint/style/noNonNullAssertion: success=false guarantees error is defined
      expect(result.error!.includes("already exists")).toBe(true);
    }
  });
});
