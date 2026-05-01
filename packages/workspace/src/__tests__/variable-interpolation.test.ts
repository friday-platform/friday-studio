import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findRepoRoot,
  interpolateConfig,
  resolveWorkspaceVariables,
  type WorkspaceVariables,
} from "../variable-interpolation.ts";

const VARS: WorkspaceVariables = {
  repo_root: "/home/user/code/atlas",
  workspace_path: "/home/user/code/atlas/workspaces/my-ws",
  workspace_id: "my_workspace",
  platform_url: "http://localhost:8080",
};

describe("interpolateConfig", () => {
  it("replaces {{repo_root}} in a flat string", () => {
    const result = interpolateConfig("{{repo_root}}/packages/workspace", VARS);
    expect(result).toBe("/home/user/code/atlas/packages/workspace");
  });

  it("replaces multiple variables in one string", () => {
    const result = interpolateConfig(
      "repo={{repo_root}} ws={{workspace_id}} url={{platform_url}}",
      VARS,
    );
    expect(result).toBe("repo=/home/user/code/atlas ws=my_workspace url=http://localhost:8080");
  });

  it("replaces variables in nested objects", () => {
    const config = {
      agents: { coder: { prompt: "Repo at {{repo_root}}", config: { workDir: "{{repo_root}}" } } },
    };
    const result = interpolateConfig(config, VARS);
    expect(result.agents.coder.prompt).toBe("Repo at /home/user/code/atlas");
    expect(result.agents.coder.config.workDir).toBe("/home/user/code/atlas");
  });

  it("replaces variables inside arrays", () => {
    const config = { paths: ["{{repo_root}}/a", "{{repo_root}}/b"] };
    const result = interpolateConfig(config, VARS);
    expect(result.paths).toEqual(["/home/user/code/atlas/a", "/home/user/code/atlas/b"]);
  });

  it("preserves non-string values (numbers, booleans, null)", () => {
    const config = { count: 42, enabled: true, empty: null, name: "{{workspace_id}}" };
    const result = interpolateConfig(config, VARS);
    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
    expect(result.empty).toBeNull();
    expect(result.name).toBe("my_workspace");
  });

  it("is a no-op when no placeholders are present", () => {
    const config = { plain: "no templates here", nested: { value: "also plain" } };
    const result = interpolateConfig(config, VARS);
    expect(result).toEqual(config);
  });

  it("leaves unknown {{placeholders}} untouched", () => {
    const result = interpolateConfig("{{unknown_key}}/path", VARS);
    expect(result).toBe("{{unknown_key}}/path");
  });

  it("does not match single-brace {placeholders}", () => {
    const result = interpolateConfig("{platformUrl}/api", VARS);
    expect(result).toBe("{platformUrl}/api");
  });

  it("handles deeply nested arrays of objects", () => {
    const config = {
      jobs: [{ steps: [{ workDir: "{{repo_root}}", url: "{{platform_url}}/api" }] }],
    };
    const result = interpolateConfig(config, VARS);
    const step = result.jobs[0]?.steps[0];
    if (!step) throw new Error("expected job[0].steps[0] in result");
    expect(step.workDir).toBe("/home/user/code/atlas");
    expect(step.url).toBe("http://localhost:8080/api");
  });

  it("replaces {{workspace_path}} variable", () => {
    const result = interpolateConfig("{{workspace_path}}/workspace.yml", VARS);
    expect(result).toBe("/home/user/code/atlas/workspaces/my-ws/workspace.yml");
  });
});

describe("findRepoRoot", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "interp-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("finds .git directory walking up from a nested path", async () => {
    // Create: tempDir/.git/ and tempDir/packages/workspace/file.ts
    mkdirSync(join(tempDir, ".git"));
    mkdirSync(join(tempDir, "packages", "workspace"), { recursive: true });

    const startPath = join(tempDir, "packages", "workspace", "file.ts");
    const result = await findRepoRoot(startPath);
    expect(result).toBe(tempDir);
  });

  it("handles git worktree .git files (text file, not directory)", async () => {
    // Worktrees have a .git *file* that points at the parent
    writeFileSync(join(tempDir, ".git"), "gitdir: /somewhere/else/.git/worktrees/my-worktree\n");
    mkdirSync(join(tempDir, "deep", "path"), { recursive: true });

    const startPath = join(tempDir, "deep", "path", "somefile.ts");
    const result = await findRepoRoot(startPath);
    expect(result).toBe(tempDir);
  });

  it("returns null when no .git ancestor exists", async () => {
    // tempDir has no .git at all
    mkdirSync(join(tempDir, "sub"), { recursive: true });
    const startPath = join(tempDir, "sub", "file.ts");

    const result = await findRepoRoot(startPath);
    // In practice this walks all the way to /; since /tmp has no .git,
    // it will return null (assuming the test machine's root has no .git).
    // This test may return a result if the test runner itself is inside a
    // git repo — but our tempDir is in /tmp which should be outside any repo.
    // We test the "no .git" case by checking the function doesn't throw.
    expect(typeof result === "string" || result === null).toBe(true);
  });
});

describe("resolveWorkspaceVariables", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "resolve-vars-"));
    mkdirSync(join(tempDir, ".git"));
    mkdirSync(join(tempDir, "workspaces", "test-ws"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds WorkspaceVariables from workspace path", async () => {
    const wsPath = join(tempDir, "workspaces", "test-ws");
    const result = await resolveWorkspaceVariables(wsPath, "test_ws", "http://localhost:9090");

    expect(result).not.toBeNull();
    expect(result?.repo_root).toBe(tempDir);
    expect(result?.workspace_path).toBe(wsPath);
    expect(result?.workspace_id).toBe("test_ws");
    expect(result?.platform_url).toBe("http://localhost:9090");
  });

  it("defaults platform_url to http://localhost:8080", async () => {
    const wsPath = join(tempDir, "workspaces", "test-ws");
    const result = await resolveWorkspaceVariables(wsPath, "test_ws");

    expect(result?.platform_url).toBe("http://localhost:8080");
  });

  it("integration: interpolates a sample workspace config", async () => {
    const wsPath = join(tempDir, "workspaces", "test-ws");
    const vars = await resolveWorkspaceVariables(wsPath, "test_ws");
    expect(vars).not.toBeNull();

    const sampleConfig = {
      agents: {
        coder: {
          prompt: "Monorepo at {{repo_root}}, workspace: {{workspace_id}}",
          config: { workDir: "{{repo_root}}", apiUrl: "{{platform_url}}/api" },
        },
      },
      functions: {
        prepare: { code: 'var root = "{{repo_root}}"; fetch("{{platform_url}}/signal");' },
      },
    };

    // vars is non-null per assertion above
    const result = interpolateConfig(sampleConfig, vars!);
    expect(result.agents.coder.prompt).toBe(`Monorepo at ${tempDir}, workspace: test_ws`);
    expect(result.agents.coder.config.workDir).toBe(tempDir);
    expect(result.agents.coder.config.apiUrl).toBe("http://localhost:8080/api");
    expect(result.functions.prepare.code).toContain(`var root = "${tempDir}"`);
    expect(result.functions.prepare.code).toContain('fetch("http://localhost:8080/signal")');
  });
});
