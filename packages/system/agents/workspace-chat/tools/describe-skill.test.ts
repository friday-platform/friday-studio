import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveVisibleSkills, mockSkillStorageGet } = vi.hoisted(() => ({
  mockResolveVisibleSkills: vi.fn(),
  mockSkillStorageGet: vi.fn(),
}));

vi.mock("@atlas/skills", () => ({
  resolveVisibleSkills: mockResolveVisibleSkills,
  SkillStorage: { get: mockSkillStorageGet },
}));

import { createDescribeSkillTool } from "./describe-skill.ts";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  mockResolveVisibleSkills.mockReset();
  mockSkillStorageGet.mockReset();
});

interface ToolWithExecute {
  execute: (input: unknown, opts: unknown) => Promise<unknown>;
}

function getTool(workspaceId: string): ToolWithExecute {
  const tools = createDescribeSkillTool(workspaceId, logger);
  return tools.describe_skill as unknown as ToolWithExecute;
}

const skillFixture = {
  name: "writing-to-memory",
  namespace: "friday",
  description: "How to write to memory stores",
  version: 3,
  disabled: false,
  body: "(full skill body — should not be returned)",
};

describe("describe_skill", () => {
  it("returns metadata in an envelope without the body", async () => {
    mockResolveVisibleSkills.mockResolvedValue([
      { name: skillFixture.name, namespace: skillFixture.namespace },
    ]);
    mockSkillStorageGet.mockResolvedValue({ ok: true, data: skillFixture });

    const tool = getTool("ws-1");
    const result = (await tool.execute({ name: "@friday/writing-to-memory" }, {})) as {
      items: Array<{ name: string; description: string; version: number }>;
      provenance: { source: string; origin: string };
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      name: "writing-to-memory",
      namespace: "friday",
      description: "How to write to memory stores",
      version: 3,
      disabled: false,
    });
    expect(JSON.stringify(result)).not.toContain(skillFixture.body);
    expect(result.provenance.source).toBe("system-config");
    expect(result.provenance.origin).toBe("skill:friday/writing-to-memory");
  });

  it("rejects skills that aren't visible to the workspace", async () => {
    // Visible list intentionally excludes the requested skill — this is
    // the load-bearing scope filter.
    mockResolveVisibleSkills.mockResolvedValue([{ name: "composing-emails", namespace: "friday" }]);
    const tool = getTool("ws-1");
    const result = (await tool.execute({ name: "@friday/writing-to-memory" }, {})) as {
      error: string;
    };

    expect(result.error).toMatch(/not visible to workspace/);
    expect(mockSkillStorageGet).not.toHaveBeenCalled();
  });

  it("returns an error on invalid skill ref", async () => {
    mockResolveVisibleSkills.mockResolvedValue([]);
    const tool = getTool("ws-1");
    const result = (await tool.execute({ name: "not-a-valid-ref" }, {})) as { error: string };
    expect(result.error).toMatch(/Invalid skill ref/);
    expect(mockResolveVisibleSkills).not.toHaveBeenCalled();
  });

  it("reports lookup failure when SkillStorage.get fails", async () => {
    mockResolveVisibleSkills.mockResolvedValue([
      { name: skillFixture.name, namespace: skillFixture.namespace },
    ]);
    mockSkillStorageGet.mockResolvedValue({ ok: false, error: "kv timeout" });

    const tool = getTool("ws-1");
    const result = (await tool.execute({ name: "@friday/writing-to-memory" }, {})) as {
      error: string;
    };
    expect(result.error).toMatch(/Skill lookup failed/);
  });

  it("reports not-found when SkillStorage returns null data", async () => {
    mockResolveVisibleSkills.mockResolvedValue([
      { name: skillFixture.name, namespace: skillFixture.namespace },
    ]);
    mockSkillStorageGet.mockResolvedValue({ ok: true, data: null });

    const tool = getTool("ws-1");
    const result = (await tool.execute({ name: "@friday/writing-to-memory" }, {})) as {
      error: string;
    };
    expect(result.error).toMatch(/not found/);
  });
});
