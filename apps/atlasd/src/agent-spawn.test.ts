import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAgentSpawnArgs } from "./agent-spawn.ts";

const ENV_VARS = ["FRIDAY_UV_PATH", "FRIDAY_AGENT_SDK_VERSION", "FRIDAY_AGENT_PYTHON"] as const;

function clearEnv() {
  for (const key of ENV_VARS) delete process.env[key];
}

describe("buildAgentSpawnArgs", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_VARS) original[key] = process.env[key];
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
    for (const key of ENV_VARS) {
      if (original[key] !== undefined) process.env[key] = original[key];
    }
  });

  describe(".py — uv-run tier (production)", () => {
    it("uses uv run --with friday-agent-sdk when FRIDAY_UV_PATH and FRIDAY_AGENT_SDK_VERSION are set", () => {
      process.env.FRIDAY_UV_PATH = "/opt/homebrew/bin/uv";
      process.env.FRIDAY_AGENT_SDK_VERSION = "0.1.1";

      const [cmd, args] = buildAgentSpawnArgs("/agents/agent.py");

      expect(cmd).toBe("/opt/homebrew/bin/uv");
      expect(args).toEqual([
        "run",
        "--python",
        "3.12",
        "--with",
        "friday-agent-sdk==0.1.1",
        "/agents/agent.py",
      ]);
    });

    describe("project-style agent (pyproject.toml present)", () => {
      let tmpDir: string;

      beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), "agent-spawn-test-"));
      });

      afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
      });

      it("adds --directory <agent_dir> AND keeps the --with friday-agent-sdk pin", () => {
        // Project-style detection — agent dir contains a pyproject.toml.
        // The pin must NOT be dropped: it's the launcher's reproducibility
        // invariant (see apps/atlasd/CLAUDE.md). uv accepts --directory and
        // --with together; --directory installs the project's declared
        // deps from its lockfile, --with overlays the SDK pin on top.
        writeFileSync(join(tmpDir, "pyproject.toml"), "[project]\nname='x'\nversion='0'\n");
        const agentPath = join(tmpDir, "agent.py");
        writeFileSync(agentPath, "");
        process.env.FRIDAY_UV_PATH = "/opt/homebrew/bin/uv";
        process.env.FRIDAY_AGENT_SDK_VERSION = "0.1.8";

        const [cmd, args] = buildAgentSpawnArgs(agentPath);

        expect(cmd).toBe("/opt/homebrew/bin/uv");
        expect(args).toEqual([
          "run",
          "--directory",
          tmpDir,
          "--python",
          "3.12",
          "--with",
          "friday-agent-sdk==0.1.8",
          "python",
          agentPath,
        ]);
      });

      it("uses single-file shape when agent dir lacks pyproject.toml", () => {
        // Boundary case: tmp dir exists but has no pyproject.toml. The
        // existsSync check should return false and we fall through to the
        // bare --with shape (no --directory).
        const agentPath = join(tmpDir, "agent.py");
        writeFileSync(agentPath, "");
        process.env.FRIDAY_UV_PATH = "/opt/homebrew/bin/uv";
        process.env.FRIDAY_AGENT_SDK_VERSION = "0.1.8";

        const [cmd, args] = buildAgentSpawnArgs(agentPath);

        expect(cmd).toBe("/opt/homebrew/bin/uv");
        expect(args).toEqual([
          "run",
          "--python",
          "3.12",
          "--with",
          "friday-agent-sdk==0.1.8",
          agentPath,
        ]);
      });

      it("resolves relative agent paths so pyproject detection isn't keyed off cwd", () => {
        // A relative `agentPath` would make `dirname()` return ".", and
        // `existsSync(join(".", "pyproject.toml"))` would resolve against
        // process.cwd() — pointing uv at the wrong tree (and `--directory .`
        // is similarly cwd-dependent). The function should resolve to an
        // absolute path before deriving the dir.
        // We don't put a pyproject in cwd, so this also asserts the bare
        // `--with` shape — verifying the resolved path doesn't accidentally
        // pick up a pyproject from the daemon's working directory.
        const relativePath = "relative/agent.py";
        process.env.FRIDAY_UV_PATH = "/opt/homebrew/bin/uv";
        process.env.FRIDAY_AGENT_SDK_VERSION = "0.1.8";

        const [cmd, args] = buildAgentSpawnArgs(relativePath);

        expect(cmd).toBe("/opt/homebrew/bin/uv");
        // The trailing path is the resolved absolute form, NOT the
        // input string. We can't pin the exact value without knowing
        // the test process cwd, so assert the shape + that it's
        // absolute.
        expect(args.slice(0, -1)).toEqual([
          "run",
          "--python",
          "3.12",
          "--with",
          "friday-agent-sdk==0.1.8",
        ]);
        const finalPath = args[args.length - 1] ?? "";
        expect(finalPath.startsWith("/")).toBe(true);
        expect(finalPath.endsWith("/relative/agent.py")).toBe(true);
      });
    });

    it("falls through to FRIDAY_AGENT_PYTHON when FRIDAY_AGENT_SDK_VERSION is unset", () => {
      // Both vars are required for the uv-run path. Missing version => fall through.
      process.env.FRIDAY_UV_PATH = "/opt/homebrew/bin/uv";
      process.env.FRIDAY_AGENT_PYTHON = "/custom/python";

      const [cmd, args] = buildAgentSpawnArgs("/agents/agent.py");

      expect(cmd).toBe("/custom/python");
      expect(args).toEqual(["/agents/agent.py"]);
    });

    it("falls through to FRIDAY_AGENT_PYTHON when FRIDAY_UV_PATH is unset", () => {
      process.env.FRIDAY_AGENT_SDK_VERSION = "0.1.1";
      process.env.FRIDAY_AGENT_PYTHON = "/custom/python";

      const [cmd, args] = buildAgentSpawnArgs("/agents/agent.py");

      expect(cmd).toBe("/custom/python");
      expect(args).toEqual(["/agents/agent.py"]);
    });
  });

  describe(".py — manual override tier", () => {
    it("uses FRIDAY_AGENT_PYTHON when uv-run vars are missing", () => {
      process.env.FRIDAY_AGENT_PYTHON = "/opt/friday/agent-runtime/bin/python";

      const [cmd, args] = buildAgentSpawnArgs("/agents/agent.py");

      expect(cmd).toBe("/opt/friday/agent-runtime/bin/python");
      expect(args).toEqual(["/agents/agent.py"]);
    });
  });

  describe(".py — dev fallback tier", () => {
    it("uses bare python3 when no env vars are set", () => {
      const [cmd, args] = buildAgentSpawnArgs("/agents/agent.py");

      expect(cmd).toBe("python3");
      expect(args).toEqual(["/agents/agent.py"]);
    });
  });

  describe(".ts entrypoints", () => {
    it("uses deno run regardless of Python env vars", () => {
      process.env.FRIDAY_UV_PATH = "/opt/homebrew/bin/uv";
      process.env.FRIDAY_AGENT_SDK_VERSION = "0.1.1";

      const [cmd, args] = buildAgentSpawnArgs("/agents/agent.ts");

      expect(cmd).toBe("deno");
      expect(args).toEqual([
        "run",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "/agents/agent.ts",
      ]);
    });
  });

  describe("other entrypoints", () => {
    it("returns the entrypoint as-is for executables", () => {
      const [cmd, args] = buildAgentSpawnArgs("/usr/local/bin/some-binary");

      expect(cmd).toBe("/usr/local/bin/some-binary");
      expect(args).toEqual([]);
    });
  });
});
