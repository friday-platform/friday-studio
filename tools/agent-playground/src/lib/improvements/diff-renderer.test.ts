import { describe, expect, it } from "vitest";
import { computeUnifiedDiff, parseDiffStats } from "./diff-renderer.ts";

describe("computeUnifiedDiff", () => {
  it("produces unified diff for changed lines", () => {
    const before = "name: my-workspace\nagents:\n  planner:\n    retries: 1\n    timeout: 30";
    const after = "name: my-workspace\nagents:\n  planner:\n    retries: 3\n    timeout: 30";

    const diff = computeUnifiedDiff(before, after);

    expect(diff).toContain("--- a/workspace.yml");
    expect(diff).toContain("+++ b/workspace.yml");
    expect(diff).toContain("@@");
    expect(diff).toContain("-    retries: 1");
    expect(diff).toContain("+    retries: 3");
  });

  it("returns empty string for identical inputs", () => {
    const text = "name: test\nagents: {}";
    expect(computeUnifiedDiff(text, text)).toBe("");
  });

  it("handles added lines", () => {
    const before = "line1\nline2";
    const after = "line1\nline2\nline3";

    const diff = computeUnifiedDiff(before, after);

    expect(diff).toContain("+line3");
    expect(diff).not.toContain("-line3");
  });

  it("handles removed lines", () => {
    const before = "line1\nline2\nline3";
    const after = "line1\nline3";

    const diff = computeUnifiedDiff(before, after);

    expect(diff).toContain("-line2");
  });

  it("uses custom filename", () => {
    const diff = computeUnifiedDiff("a", "b", "config.yml");

    expect(diff).toContain("--- a/config.yml");
    expect(diff).toContain("+++ b/config.yml");
  });
});

describe("parseDiffStats", () => {
  it("counts additions and deletions", () => {
    const diff = [
      "--- a/workspace.yml",
      "+++ b/workspace.yml",
      "@@ -1,3 +1,3 @@",
      " name: test",
      "-retries: 1",
      "+retries: 3",
      " timeout: 30",
    ].join("\n");

    const stats = parseDiffStats(diff);

    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(1);
  });

  it("returns zero for empty diff", () => {
    const stats = parseDiffStats("");
    expect(stats.additions).toBe(0);
    expect(stats.deletions).toBe(0);
  });

  it("does not count header lines as changes", () => {
    const diff = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";
    const stats = parseDiffStats(diff);

    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(1);
  });

  it("counts multiple additions correctly", () => {
    const diff = "@@ -1,2 +1,4 @@\n line1\n+added1\n+added2\n line2";
    const stats = parseDiffStats(diff);

    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(0);
  });
});
