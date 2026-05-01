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
