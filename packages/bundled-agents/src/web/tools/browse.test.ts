import type { StreamEmitter } from "@atlas/agent-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports)
// ---------------------------------------------------------------------------
const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
type ExecFileCallback = (
  err: NodeJS.ErrnoException | null,
  result?: { stdout: string; stderr: string },
) => void;

type ExecFileCall = [string, string[], Record<string, unknown>, ExecFileCallback];

/** Make execFile succeed with the given stdout/stderr for every call. */
function mockExecSuccess(stdout = "ok", stderr = "") {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: ExecFileCallback) => {
      cb(null, { stdout, stderr });
    },
  );
}

/** Make execFile fail with the given error. */
function mockExecFailure(error: Error) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: ExecFileCallback) => {
      cb(error as NodeJS.ErrnoException);
    },
  );
}

function makeStream(): { emit: ReturnType<typeof vi.fn> } & StreamEmitter {
  const emit = vi.fn();
  return { emit } as unknown as { emit: ReturnType<typeof vi.fn> } & StreamEmitter;
}

async function runBrowse(
  browseTool: ReturnType<typeof import("./browse.ts").createBrowseTool>,
  command: string,
): Promise<string> {
  const execute = (
    browseTool as unknown as { execute: (input: { command: string }) => Promise<string> }
  ).execute;
  return await execute({ command });
}

// ---------------------------------------------------------------------------
// Isolated-mode tests (AGENT_BROWSER_AUTO_CONNECT unset)
// ---------------------------------------------------------------------------
describe("createBrowseTool — isolated mode (no auto-connect)", () => {
  let browseMod: typeof import("./browse.ts");

  beforeEach(async () => {
    vi.stubEnv("AGENT_BROWSER_AUTO_CONNECT", "");
    vi.resetModules();
    mockExecFile.mockReset();
    browseMod = await import("./browse.ts");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("invokes agent-browser with --session and first-call timeout", async () => {
    mockExecSuccess("heading: Example");
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-abc",
      daemonStarted: false,
    };
    const stream = makeStream();
    const tool = browseMod.createBrowseTool(stream, state);

    const out = await runBrowse(tool, "open https://example.com");

    expect(out).toBe("heading: Example");
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as ExecFileCall;
    expect(cmd).toBe("agent-browser");
    expect(args).toEqual(["--session", "atlas-web-abc", "open", "https://example.com"]);
    expect(opts.timeout).toBe(60_000);
  });

  test("flips daemonStarted and emits progress once per agent invocation", async () => {
    mockExecSuccess("ok");
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: false,
    };
    const stream = makeStream();
    const tool = browseMod.createBrowseTool(stream, state);

    await runBrowse(tool, "open https://example.com");
    await runBrowse(tool, "snapshot -i");
    await runBrowse(tool, "click @e3");

    expect(state.daemonStarted).toBe(true);
    expect(stream.emit).toHaveBeenCalledTimes(1);
    expect(stream.emit).toHaveBeenCalledWith({
      type: "data-tool-progress",
      data: { toolName: "Web", content: "Starting browser..." },
    });
  });

  test("uses COMMAND_TIMEOUT_MS after first successful call", async () => {
    mockExecSuccess("ok");
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: false,
    };
    const tool = browseMod.createBrowseTool(undefined, state);

    await runBrowse(tool, "open https://example.com");
    await runBrowse(tool, "snapshot -i");

    const firstOpts = (mockExecFile.mock.calls[0] as ExecFileCall)[2];
    const secondOpts = (mockExecFile.mock.calls[1] as ExecFileCall)[2];
    expect(firstOpts.timeout).toBe(60_000);
    expect(secondOpts.timeout).toBe(30_000);
  });

  test("does not flip daemonStarted on failure", async () => {
    mockExecFailure(new Error("boom"));
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: false,
    };
    const stream = makeStream();
    const tool = browseMod.createBrowseTool(stream, state);

    const out = await runBrowse(tool, "open https://example.com");

    expect(out).toContain("Error:");
    expect(state.daemonStarted).toBe(false);
    expect(stream.emit).not.toHaveBeenCalled();
  });

  test("stopSession is a no-op when daemon never started", async () => {
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: false,
    };
    await browseMod.stopSession(state);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test("stopSession calls agent-browser close when daemon started", async () => {
    mockExecSuccess("");
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: true,
    };

    await browseMod.stopSession(state);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as ExecFileCall;
    expect(cmd).toBe("agent-browser");
    expect(args).toEqual(["--session", "atlas-web-xyz", "close"]);
    expect(opts.timeout).toBe(5_000);
    expect(state.daemonStarted).toBe(false);
  });

  test("stopSession swallows close errors", async () => {
    mockExecFailure(new Error("close failed"));
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: true,
    };

    await expect(browseMod.stopSession(state)).resolves.toBeUndefined();
    expect(state.daemonStarted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-connect mode tests (AGENT_BROWSER_AUTO_CONNECT=1)
// ---------------------------------------------------------------------------
describe("createBrowseTool — auto-connect mode", () => {
  let browseMod: typeof import("./browse.ts");

  beforeEach(async () => {
    vi.stubEnv("AGENT_BROWSER_AUTO_CONNECT", "1");
    vi.resetModules();
    mockExecFile.mockReset();
    browseMod = await import("./browse.ts");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("omits --session flag from argv", async () => {
    mockExecSuccess("ok");
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: false,
    };
    const tool = browseMod.createBrowseTool(undefined, state);

    await runBrowse(tool, "open https://example.com");

    const [cmd, args] = mockExecFile.mock.calls[0] as ExecFileCall;
    expect(cmd).toBe("agent-browser");
    expect(args).toEqual(["open", "https://example.com"]);
    expect(args).not.toContain("--session");
  });

  test("stopSession is a no-op even when daemonStarted is true", async () => {
    const state: import("./browse.ts").SessionState = {
      sessionName: "atlas-web-xyz",
      daemonStarted: true,
    };

    await browseMod.stopSession(state);

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
