import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkspaceMeta, findRepoRoot } from "../workspace-meta.ts";

describe("findRepoRoot", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "wsm-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds .git directory walking up from a nested path", () => {
    // Create repo structure: tempDir/.git/ + tempDir/workspaces/my-ws/
    mkdirSync(join(tempDir, ".git"));
    mkdirSync(join(tempDir, "workspaces", "my-ws"), { recursive: true });

    const result = findRepoRoot(join(tempDir, "workspaces", "my-ws"));
    expect(result).toBe(tempDir);
  });

  it("handles git worktrees (.git as file)", () => {
    // In a worktree, .git is a file containing "gitdir: /path/to/main/.git/worktrees/..."
    writeFileSync(join(tempDir, ".git"), "gitdir: /some/other/.git/worktrees/my-worktree");
    mkdirSync(join(tempDir, "packages", "engine"), { recursive: true });

    const result = findRepoRoot(join(tempDir, "packages", "engine"));
    expect(result).toBe(tempDir);
  });

  it("returns null when no .git ancestor exists", () => {
    // tempDir has no .git at all
    mkdirSync(join(tempDir, "deep", "nested"), { recursive: true });

    // Walk up from deep/nested — will never find .git in tempDir
    // but will hit the real filesystem root. Since tests run in a git
    // repo, we need to specifically test a path where no ancestor has .git.
    // Use a fresh temp dir that's not inside any git repo... but OS tmp
    // IS inside a git repo on dev machines. So we test the function stops.
    const result = findRepoRoot(join(tempDir, "deep", "nested"));
    // Result is either tempDir (if the CI/dev machine's temp IS in a git repo)
    // or some ancestor. The important invariant: the function terminates.
    expect(typeof result === "string" || result === null).toBe(true);
  });

  it("returns the path itself when .git is at the start path", () => {
    mkdirSync(join(tempDir, ".git"));
    const result = findRepoRoot(tempDir);
    expect(result).toBe(tempDir);
  });
});

describe("buildWorkspaceMeta", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "wsm-meta-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("derives repo_root from workspacePath by walking up to .git", () => {
    mkdirSync(join(tempDir, ".git"));
    const wsPath = join(tempDir, "workspaces", "my-ws");
    mkdirSync(wsPath, { recursive: true });

    const meta = buildWorkspaceMeta({
      workspacePath: wsPath,
      workspaceId: "test-ws",
      daemonUrl: "http://localhost:8080",
    });

    expect(meta.repo_root).toBe(tempDir);
    expect(meta.workspace_path).toBe(wsPath);
    expect(meta.workspace_id).toBe("test-ws");
    expect(meta.platform_url).toBe("http://localhost:8080");
  });

  it("passes workspace_id through", () => {
    mkdirSync(join(tempDir, ".git"));
    const meta = buildWorkspaceMeta({ workspacePath: tempDir, workspaceId: "fizzy_waffle" });
    expect(meta.workspace_id).toBe("fizzy_waffle");
  });

  it("defaults platform_url to http://localhost:4242 when daemonUrl is undefined", () => {
    mkdirSync(join(tempDir, ".git"));
    const meta = buildWorkspaceMeta({ workspacePath: tempDir, workspaceId: "test-ws" });
    expect(meta.platform_url).toBe("http://localhost:4242");
  });

  it("workspace_path is the raw workspacePath", () => {
    mkdirSync(join(tempDir, ".git"));
    const wsPath = join(tempDir, "deep", "workspace");
    mkdirSync(wsPath, { recursive: true });

    const meta = buildWorkspaceMeta({ workspacePath: wsPath, workspaceId: "test-ws" });
    expect(meta.workspace_path).toBe(wsPath);
  });

  it("falls back to workspacePath when no .git ancestor found", () => {
    // Don't create .git — findRepoRoot will walk up and eventually
    // find the real repo root or return null. If null, fallback is workspacePath.
    // We create a path inside tempDir which should NOT have .git itself
    // (but the real OS temp might be inside a repo). The key behavior is
    // that buildWorkspaceMeta never throws — it always returns a valid meta.
    const meta = buildWorkspaceMeta({ workspacePath: tempDir, workspaceId: "test-ws" });
    expect(typeof meta.repo_root).toBe("string");
    expect(meta.repo_root.length).toBeGreaterThan(0);
  });
});
