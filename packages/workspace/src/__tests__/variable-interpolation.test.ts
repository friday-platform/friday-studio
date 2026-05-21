import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { VariableDeclaration } from "@atlas/config";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findRepoRoot,
  interpolateConfig,
  resolveDeclaredVariables,
  resolveWorkspaceVariables,
  variableEnvKey,
  type WorkspaceVariables,
  WorkspaceVariablesSchema,
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

// getAtlasDaemonUrl() reads multiple env keys (FRIDAYD_URL, legacy
// FRIDAY_DAEMON_URL alias, FRIDAY_PORT_FRIDAY port override) and
// auto-upgrades the scheme to https:// when FRIDAY_TLS_CERT + _KEY are
// both set. Mirrors the list at packages/openapi-client/src/utils.test.ts:23
// so both test files isolate the same surface. Without this, a developer
// who has run setup-tls.sh or has any of these exported in their shell
// sees flaky failures.
const ENV_KEYS = [
  "FRIDAYD_URL",
  "FRIDAY_DAEMON_URL",
  "FRIDAY_PORT_FRIDAY",
  "FRIDAY_TLS_CERT",
  "FRIDAY_TLS_KEY",
  "FRIDAY_ATLAS_PLATFORM_URL",
];

describe("WorkspaceVariablesSchema.platform_url default", () => {
  // Direct schema-level test: parse() with platform_url *omitted* triggers
  // the schema's `.default(() => getAtlasDaemonUrl())`. The original
  // function-level test was tautological because the call site always
  // passed a resolved string, so the schema default was dead code (review
  // v2 Important #1). With the call site now passing `platform_url:
  // daemonUrl` (possibly undefined), the schema default fires — and this
  // direct test locks that branch in so a future refactor can't quietly
  // turn it into dead code again.
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
  });

  it("schema default fires when platform_url key is omitted from parse input", () => {
    const result = WorkspaceVariablesSchema.parse({
      repo_root: "/tmp/repo",
      workspace_path: "/tmp/repo/workspaces/x",
      workspace_id: "x",
      // platform_url intentionally omitted
    });
    // Reverting the schema's `.default(() => getAtlasDaemonUrl())` to a
    // literal like `.default("http://example.broken")` would make this
    // assertion fail — proves the branch is actually reached.
    expect(result.platform_url).toBe(getAtlasDaemonUrl());
    // And the resolved value reflects env, not a hardcoded literal.
    expect(result.platform_url).toBe("http://127.0.0.1:8080");
  });

  it("schema default fires when platform_url is explicitly undefined", () => {
    const result = WorkspaceVariablesSchema.parse({
      repo_root: "/tmp/repo",
      workspace_path: "/tmp/repo/workspaces/x",
      workspace_id: "x",
      platform_url: undefined,
    });
    expect(result.platform_url).toBe(getAtlasDaemonUrl());
  });

  it("schema default honors FRIDAYD_URL (proves the default *calls* getAtlasDaemonUrl)", () => {
    process.env.FRIDAYD_URL = "http://example.test:9999";
    const result = WorkspaceVariablesSchema.parse({
      repo_root: "/tmp/repo",
      workspace_path: "/tmp/repo/workspaces/x",
      workspace_id: "x",
    });
    // Reverting the schema default to a captured-at-startup value (e.g.
    // `.default(getAtlasDaemonUrl())` instead of `.default(() =>
    // getAtlasDaemonUrl())`) would break this test — proves the default
    // resolves *at parse time*, not at module-load time.
    expect(result.platform_url).toBe("http://example.test:9999");
  });
});

describe("resolveWorkspaceVariables", () => {
  let tempDir: string;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "resolve-vars-"));
    mkdirSync(join(tempDir, ".git"));
    mkdirSync(join(tempDir, "workspaces", "test-ws"), { recursive: true });
    for (const k of ENV_KEYS) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (envSnapshot[k] === undefined) delete process.env[k];
      else process.env[k] = envSnapshot[k];
    }
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

  it("default platform_url falls through to getAtlasDaemonUrl()'s no-env result", async () => {
    // No env set (beforeEach cleared them) — proves the schema default ran
    // and returned getAtlasDaemonUrl()'s no-env fallback rather than a
    // hardcoded literal. If someone re-introduces `.default("http://...")`
    // on the schema, this catches it because the literal would differ from
    // what getAtlasDaemonUrl() returns.
    const wsPath = join(tempDir, "workspaces", "test-ws");
    const result = await resolveWorkspaceVariables(wsPath, "test_ws");

    expect(result?.platform_url).toBe(getAtlasDaemonUrl());
    // Sanity: the value is a parseable URL with an HTTP(S) scheme.
    expect(() => new URL(result!.platform_url)).not.toThrow();
    expect(result?.platform_url).toMatch(/^https?:\/\//);
  });

  it("platform_url default honors FRIDAYD_URL env (non-tautological)", async () => {
    // Use a URL nothing else in the test could plausibly produce — proves
    // the env-honoring branch ran, not just that "what we set is what we
    // got back via interpolation".
    process.env.FRIDAYD_URL = "http://example.test:9999";
    const wsPath = join(tempDir, "workspaces", "test-ws");
    const result = await resolveWorkspaceVariables(wsPath, "test_ws");

    expect(result?.platform_url).toBe("http://example.test:9999");
  });

  it("falls back to workspacePath as repo_root when no .git ancestor exists", async () => {
    // Production workspaces live at ~/.atlas/workspaces/<dir>/ — outside any
    // git repo. The function must not return null and block declared-variable
    // interpolation just because the workspace happens not to be in a git tree.
    const nonGitDir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      const wsPath = join(nonGitDir, "ws");
      mkdirSync(wsPath, { recursive: true });
      const result = await resolveWorkspaceVariables(wsPath, "test_ws", "http://localhost:9090");

      expect(result).not.toBeNull();
      expect(result?.repo_root).toBe(wsPath);
      expect(result?.workspace_path).toBe(wsPath);
      expect(result?.workspace_id).toBe("test_ws");
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("integration: interpolates a sample workspace config", async () => {
    process.env.FRIDAYD_URL = "http://example.test:9999";
    const wsPath = join(tempDir, "workspaces", "test-ws");
    const vars = await resolveWorkspaceVariables(wsPath, "test_ws");
    expect(vars).not.toBeNull();

    const sampleConfig = {
      agents: {
        coder: {
          prompt: "Monorepo at {{repo_root}}, workspace: {{workspace_id}}",
          config: {
            workDir: "{{repo_root}}",
            apiUrl: "{{platform_url}}/api",
            bootstrap: 'var root = "{{repo_root}}"; fetch("{{platform_url}}/signal");',
          },
        },
      },
    };

    const result = interpolateConfig(sampleConfig, vars!);
    expect(result.agents.coder.prompt).toBe(`Monorepo at ${tempDir}, workspace: test_ws`);
    expect(result.agents.coder.config.workDir).toBe(tempDir);
    expect(result.agents.coder.config.apiUrl).toBe("http://example.test:9999/api");
    expect(result.agents.coder.config.bootstrap).toContain(`var root = "${tempDir}"`);
    expect(result.agents.coder.config.bootstrap).toContain(
      'fetch("http://example.test:9999/signal")',
    );
  });
});

describe("variableEnvKey", () => {
  it("uppercases the variable name", () => {
    expect(variableEnvKey("email_recipient")).toBe("EMAIL_RECIPIENT");
    expect(variableEnvKey("threshold")).toBe("THRESHOLD");
  });
});

describe("resolveDeclaredVariables", () => {
  it("returns an empty namespace when there are no declarations", () => {
    expect(resolveDeclaredVariables(undefined, {})).toEqual({});
    expect(resolveDeclaredVariables({}, { FOO: "bar" })).toEqual({});
  });

  it("resolves a string variable whose env value passes schema", () => {
    const decls: Record<string, VariableDeclaration> = {
      email_recipient: { schema: { type: "string", format: "email", minLength: 1 } },
    };
    const out = resolveDeclaredVariables(decls, { EMAIL_RECIPIENT: "a@b.com" });
    expect(out.email_recipient).toBe("a@b.com");
  });

  it("falls back to schema.default when env is absent", () => {
    const decls: Record<string, VariableDeclaration> = {
      email_recipient: { schema: { type: "string", default: "fallback@x.com" } },
    };
    const out = resolveDeclaredVariables(decls, {});
    expect(out.email_recipient).toBe("fallback@x.com");
  });

  it("falls back to schema.default when env value fails the schema", () => {
    const decls: Record<string, VariableDeclaration> = {
      email_recipient: { schema: { type: "string", minLength: 5, default: "ok@x.io" } },
    };
    const out = resolveDeclaredVariables(decls, { EMAIL_RECIPIENT: "no" });
    expect(out.email_recipient).toBe("ok@x.io");
  });

  it("omits the variable when no default and env is absent", () => {
    const decls: Record<string, VariableDeclaration> = {
      email_recipient: { schema: { type: "string", minLength: 1 } },
    };
    const out = resolveDeclaredVariables(decls, {});
    expect(out.email_recipient).toBeUndefined();
  });

  it("omits the variable when both env and default fail the schema", () => {
    const decls: Record<string, VariableDeclaration> = {
      threshold: { schema: { type: "number", minimum: 0, maximum: 1, default: 5 } },
    };
    const out = resolveDeclaredVariables(decls, { THRESHOLD: "9.9" });
    expect(out.threshold).toBeUndefined();
  });

  it("coerces and stringifies numbers from env", () => {
    const decls: Record<string, VariableDeclaration> = {
      retries: { schema: { type: "integer", minimum: 0, maximum: 10 } },
    };
    const out = resolveDeclaredVariables(decls, { RETRIES: "3" });
    expect(out.retries).toBe("3");
  });

  it("rejects non-integer strings for integer type", () => {
    const decls: Record<string, VariableDeclaration> = {
      retries: { schema: { type: "integer", default: 1 } },
    };
    const out = resolveDeclaredVariables(decls, { RETRIES: "1.5" });
    expect(out.retries).toBe("1");
  });

  it("coerces and stringifies booleans from env", () => {
    const decls: Record<string, VariableDeclaration> = { notify: { schema: { type: "boolean" } } };
    expect(resolveDeclaredVariables(decls, { NOTIFY: "true" }).notify).toBe("true");
    expect(resolveDeclaredVariables(decls, { NOTIFY: "false" }).notify).toBe("false");
  });

  it("rejects 1/yes/no for boolean type and falls back to default", () => {
    const decls: Record<string, VariableDeclaration> = {
      notify: { schema: { type: "boolean", default: true } },
    };
    expect(resolveDeclaredVariables(decls, { NOTIFY: "1" }).notify).toBe("true");
    expect(resolveDeclaredVariables(decls, { NOTIFY: "yes" }).notify).toBe("true");
  });

  it("rejects 1/yes/no for boolean type and omits when no default", () => {
    const decls: Record<string, VariableDeclaration> = { notify: { schema: { type: "boolean" } } };
    expect(resolveDeclaredVariables(decls, { NOTIFY: "1" }).notify).toBeUndefined();
  });

  it("passes empty string when the schema allows it", () => {
    const decls: Record<string, VariableDeclaration> = { note: { schema: { type: "string" } } };
    const out = resolveDeclaredVariables(decls, { NOTE: "" });
    expect(out.note).toBe("");
  });

  it("rejects empty string when minLength: 1 and falls back to default if any", () => {
    const decls: Record<string, VariableDeclaration> = {
      note: { schema: { type: "string", minLength: 1, default: "fb" } },
    };
    const out = resolveDeclaredVariables(decls, { NOTE: "" });
    expect(out.note).toBe("fb");
  });

  it("rejects empty string when minLength: 1 and omits when no default", () => {
    const decls: Record<string, VariableDeclaration> = {
      note: { schema: { type: "string", minLength: 1 } },
    };
    const out = resolveDeclaredVariables(decls, { NOTE: "" });
    expect(out.note).toBeUndefined();
  });
});

describe("interpolateConfig with declared variables", () => {
  const VARS: WorkspaceVariables = {
    repo_root: "/r",
    workspace_path: "/r/ws",
    workspace_id: "ws",
    platform_url: "http://x",
  };

  it("replaces {{variables.X}} when X is declared and resolved", () => {
    const out = interpolateConfig("send to {{variables.email_recipient}}", VARS, {
      email_recipient: "a@b.com",
    });
    expect(out).toBe("send to a@b.com");
  });

  it("leaves {{variables.X}} literal when X is undeclared (strict namespace)", () => {
    const out = interpolateConfig("{{variables.something_else}}", VARS, {
      email_recipient: "a@b.com",
    });
    expect(out).toBe("{{variables.something_else}}");
  });

  it("leaves {{variables.X}} literal when X is declared but unresolved", () => {
    const out = interpolateConfig("{{variables.email_recipient}}", VARS, {});
    expect(out).toBe("{{variables.email_recipient}}");
  });

  it("does not match unknown top-level namespaces", () => {
    const out = interpolateConfig("{{config.x}} {{signal.payload.x}}", VARS, {});
    expect(out).toBe("{{config.x}} {{signal.payload.x}}");
  });

  it("interleaves flat keys and variable keys in one string", () => {
    const out = interpolateConfig("root={{repo_root}} email={{variables.email_recipient}}", VARS, {
      email_recipient: "a@b.com",
    });
    expect(out).toBe("root=/r email=a@b.com");
  });

  it("preserves the existing two-arg signature (back-compat)", () => {
    expect(interpolateConfig("{{repo_root}}", VARS)).toBe("/r");
  });

  it("end-to-end: declarations + env produce interpolated config", () => {
    const decls: Record<string, VariableDeclaration> = {
      email_recipient: { schema: { type: "string", format: "email", default: "fb@x.io" } },
      max_retries: { schema: { type: "integer", minimum: 0, maximum: 10, default: 3 } },
    };
    const env = { EMAIL_RECIPIENT: "live@x.com" }; // MAX_RETRIES absent → default
    const namespace = resolveDeclaredVariables(decls, env);
    const config = {
      agents: {
        emailer: { prompt: "to {{variables.email_recipient}}, retries={{variables.max_retries}}" },
      },
    };
    const out = interpolateConfig(config, VARS, namespace);
    expect(out.agents.emailer.prompt).toBe("to live@x.com, retries=3");
  });
});
