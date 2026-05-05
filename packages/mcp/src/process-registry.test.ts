import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPStartupError } from "./errors.ts";
import {
  type PidFileWriter,
  type ProcessRegistryDeps,
  type SharedProcessSpec,
  sharedMCPProcesses,
} from "./process-registry.ts";

function noopPidFile(): PidFileWriter {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => fakeLogger),
} as unknown as import("@atlas/logger").Logger;

interface MockChildProcess extends ChildProcess {
  _emitExit(code: number | null, signal: NodeJS.Signals | null): void;
  _emitStderr(text: string): void;
}

function createMockChildProcess(pid = 12345): MockChildProcess {
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const stderrListeners: Array<(data: Uint8Array) => void> = [];
  let _exitCode: number | null = null;
  let _signalCode: NodeJS.Signals | null = null;
  const killMock = vi.fn((signal?: NodeJS.Signals) => {
    if (_exitCode !== null || _signalCode !== null) return false;
    _signalCode = signal ?? "SIGTERM";
    queueMicrotask(() => {
      for (const h of exitListeners) h(null, _signalCode);
    });
    return true;
  });

  return {
    pid,
    stderr: {
      on: (event: string, handler: (data: Uint8Array) => void) => {
        if (event === "data") stderrListeners.push(handler);
      },
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "exit") {
        exitListeners.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
      }
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "exit") {
        const wrapped = (code: number | null, signal: NodeJS.Signals | null): void => {
          handler(code, signal);
        };
        exitListeners.push(wrapped);
      }
    },
    kill: killMock,
    get exitCode() {
      return _exitCode;
    },
    get signalCode() {
      return _signalCode;
    },
    get killed() {
      return _signalCode !== null;
    },
    _emitExit(code: number | null, signal: NodeJS.Signals | null) {
      _exitCode = code;
      _signalCode = signal;
      for (const h of exitListeners) h(code, signal);
    },
    _emitStderr(text: string) {
      const data = new TextEncoder().encode(text);
      for (const h of stderrListeners) h(data);
    },
  } as unknown as MockChildProcess;
}

function makeSpec(overrides?: Partial<SharedProcessSpec>): SharedProcessSpec {
  return {
    command: "uvx",
    args: ["workspace-mcp", "--tools", "calendar"],
    env: { WORKSPACE_MCP_PORT: "8001" },
    readyUrl: "http://localhost:8001/mcp",
    readyTimeoutMs: 500,
    readyIntervalMs: 25,
    ...overrides,
  };
}

beforeEach(() => {
  sharedMCPProcesses._resetForTesting();
});

afterEach(() => {
  sharedMCPProcesses._resetForTesting();
  vi.restoreAllMocks();
});

describe("ProcessRegistry.acquire", () => {
  it("first call spawns; concurrent calls for same serverId reuse the same spawn", async () => {
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    // First fetch attempt connects (server reachable)
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    const [handleA, handleB, handleC] = await Promise.all([
      sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger),
      sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger),
      sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger),
    ]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(handleA.child).toBe(child);
    expect(handleB.child).toBe(child);
    expect(handleC.child).toBe(child);
  });

  it("sequential acquires for same serverId after success reuse cached child", async () => {
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    const a = await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);
    const b = await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(a.child).toBe(b.child);
  });

  it("different serverIds spawn independent children", async () => {
    const calChild = createMockChildProcess(1);
    const gmailChild = createMockChildProcess(2);
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => calChild)
      .mockImplementationOnce(() => gmailChild);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    const cal = await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);
    const gmail = await sharedMCPProcesses.acquire(
      "gmail",
      makeSpec({ readyUrl: "http://localhost:8002/mcp" }),
      deps,
      fakeLogger,
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(cal.child).toBe(calChild);
    expect(gmail.child).toBe(gmailChild);
  });

  it("spawn that throws synchronously rejects all concurrent callers and evicts cache", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT: uvx not found");
    });
    const fetchImpl = vi.fn();
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    const results = await Promise.allSettled([
      sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger),
      sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    if (results[0].status === "rejected") {
      expect(results[0].reason).toBeInstanceOf(MCPStartupError);
      expect((results[0].reason as MCPStartupError).kind).toBe("spawn");
    }

    // Cache evicted — next acquire spawns again.
    const child = createMockChildProcess();
    spawn.mockReset();
    spawn.mockReturnValue(child);
    fetchImpl.mockResolvedValue({ status: 200, ok: true } as Response);

    const handle = await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(handle.child).toBe(child);
  });

  it("child exits before becoming reachable -> rejects with MCPStartupError(spawn) and evicts cache", async () => {
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    const acquirePromise = sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);

    // Allow listeners to attach before emitting events.
    await new Promise((r) => setTimeout(r, 5));
    child._emitStderr("[AUTH] config setup\n[INFO] Protected resource metadata\n");
    child._emitExit(1, null);

    const error = await acquirePromise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MCPStartupError);
    expect((error as MCPStartupError).kind).toBe("spawn");
    expect((error as MCPStartupError).cause).toBeInstanceOf(Error);

    // Cache evicted.
    const child2 = createMockChildProcess(2);
    spawn.mockReset();
    spawn.mockReturnValue(child2);
    fetchImpl.mockReset();
    fetchImpl.mockResolvedValue({ status: 200, ok: true } as Response);

    const handle = await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(handle.child).toBe(child2);
  });

  it("polling timeout -> SIGTERM the child and throw MCPStartupError(timeout)", async () => {
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    const error = await sharedMCPProcesses
      .acquire("calendar", makeSpec({ readyTimeoutMs: 80, readyIntervalMs: 20 }), deps, fakeLogger)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MCPStartupError);
    expect((error as MCPStartupError).kind).toBe("timeout");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("child mid-life exit (after acquire resolved) evicts cache; next acquire spawns fresh", async () => {
    const child1 = createMockChildProcess(1);
    const child2 = createMockChildProcess(2);
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => child1)
      .mockImplementationOnce(() => child2);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    const a = await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);
    expect(a.child).toBe(child1);

    // Child crashes (OOM, manual kill, etc.)
    child1._emitExit(137, null);

    const b = await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(b.child).toBe(child2);
  });
});

describe("ProcessRegistry.acquire spec eviction", () => {
  it("env change for same serverId evicts the old child and respawns with new spec", async () => {
    const oldChild = createMockChildProcess(1);
    const newChild = createMockChildProcess(2);
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => oldChild)
      .mockImplementationOnce(() => newChild);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    // First acquire — old spec missing the registry's platformEnv, e.g. spawned
    // by the buggy raw-config FSM path before the fix.
    const a = await sharedMCPProcesses.acquire("gmail", makeSpec(), deps, fakeLogger);
    expect(a.child).toBe(oldChild);

    // Second acquire — same serverId, env now includes platformEnv vars.
    const newSpec = makeSpec({
      env: {
        WORKSPACE_MCP_PORT: "8001",
        MCP_ENABLE_OAUTH21: "true",
        EXTERNAL_OAUTH21_PROVIDER: "true",
      },
    });
    const b = await sharedMCPProcesses.acquire("gmail", newSpec, deps, fakeLogger);

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(oldChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(b.child).toBe(newChild);
  });

  it("command change for same serverId evicts and respawns", async () => {
    const oldChild = createMockChildProcess(1);
    const newChild = createMockChildProcess(2);
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => oldChild)
      .mockImplementationOnce(() => newChild);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    await sharedMCPProcesses.acquire("calendar", makeSpec({ command: "uvx" }), deps, fakeLogger);
    const b = await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec({ command: "/opt/homebrew/bin/uvx" }),
      deps,
      fakeLogger,
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(oldChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(b.child).toBe(newChild);
  });

  it("matching env+command+args reuses cached child even when poll timeouts differ", async () => {
    // readyTimeoutMs / readyIntervalMs don't change subprocess behavior — only
    // how long the registry waits for the child to come up. They must not
    // count toward spec equality, otherwise every caller passing different
    // timeout overrides would needlessly thrash the subprocess.
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec({ readyTimeoutMs: 500, readyIntervalMs: 25 }),
      deps,
      fakeLogger,
    );
    const b = await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec({ readyTimeoutMs: 30000, readyIntervalMs: 500 }),
      deps,
      fakeLogger,
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(b.child).toBe(child);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("env-key reordering does not cause a false eviction", async () => {
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec({ env: { A: "1", B: "2", C: "3" } }),
      deps,
      fakeLogger,
    );
    await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec({ env: { C: "3", A: "1", B: "2" } }),
      deps,
      fakeLogger,
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("eviction SIGKILLs survivors that ignore SIGTERM, then respawns", async () => {
    const stubbornChild = createMockChildProcess(1);
    // Simulate a child that ignores SIGTERM but obeys SIGKILL.
    (stubbornChild.kill as ReturnType<typeof vi.fn>).mockImplementation((sig: NodeJS.Signals) => {
      if (sig === "SIGKILL") {
        (stubbornChild as MockChildProcess)._emitExit(null, sig);
      }
      // SIGTERM ignored.
      return true;
    });
    const newChild = createMockChildProcess(2);

    const spawn = vi
      .fn()
      .mockImplementationOnce(() => stubbornChild)
      .mockImplementationOnce(() => newChild);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);

    // Trigger eviction by changing env. Run under fake timers so the 2s
    // SIGTERM grace window doesn't real-wait.
    vi.useFakeTimers();
    const acquirePromise = sharedMCPProcesses.acquire(
      "calendar",
      makeSpec({ env: { WORKSPACE_MCP_PORT: "8001", FOO: "bar" } }),
      deps,
      fakeLogger,
    );
    await vi.advanceTimersByTimeAsync(2100);
    const b = await acquirePromise;
    vi.useRealTimers();

    const calls = (stubbornChild.kill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(b.child).toBe(newChild);
  });

  it("eviction removes the old child's pid file before respawning", async () => {
    const oldChild = createMockChildProcess(11);
    const newChild = createMockChildProcess(22);
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => oldChild)
      .mockImplementationOnce(() => newChild);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const pidFile = noopPidFile();

    await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec(),
      { spawn, fetch: fetchImpl, pidFile },
      fakeLogger,
    );
    await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec({ env: { WORKSPACE_MCP_PORT: "8001", FOO: "bar" } }),
      { spawn, fetch: fetchImpl, pidFile },
      fakeLogger,
    );

    expect(pidFile.remove).toHaveBeenCalledWith("calendar");
    // Both pid writes happened — old child's then the new one's.
    const writtenPids = (pidFile.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(writtenPids).toEqual([11, 22]);
  });
});

describe("ProcessRegistry.shutdown", () => {
  it("SIGTERMs all registered children", async () => {
    const calChild = createMockChildProcess(1);
    const gmailChild = createMockChildProcess(2);
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => calChild)
      .mockImplementationOnce(() => gmailChild);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);
    await sharedMCPProcesses.acquire(
      "gmail",
      makeSpec({ readyUrl: "http://localhost:8002/mcp" }),
      deps,
      fakeLogger,
    );

    await sharedMCPProcesses.shutdown();

    expect(calChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(gmailChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("SIGKILLs survivors that don't exit during the grace window", async () => {
    const child = createMockChildProcess();
    // Simulate a child that ignores SIGTERM
    (child.kill as ReturnType<typeof vi.fn>).mockImplementation((sig: NodeJS.Signals) => {
      if (sig === "SIGKILL") {
        (child as MockChildProcess)._emitExit(null, sig);
      }
      // SIGTERM ignored — child stays alive.
      return true;
    });

    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile: noopPidFile() };

    await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);

    // shutdown waits up to 2s; speed it up by not real-waiting (the grace
    // window is hard-coded). Use a fake timer to fast-forward.
    vi.useFakeTimers();
    const shutdownPromise = sharedMCPProcesses.shutdown();
    await vi.advanceTimersByTimeAsync(2100);
    await shutdownPromise;
    vi.useRealTimers();

    const calls = (child.kill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("acquire after shutdown rejects", async () => {
    await sharedMCPProcesses.shutdown();

    const error = await sharedMCPProcesses
      .acquire(
        "calendar",
        makeSpec(),
        { spawn: vi.fn(), fetch: vi.fn(), pidFile: noopPidFile() },
        fakeLogger,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MCPStartupError);
    expect((error as MCPStartupError).kind).toBe("spawn");
  });

  it("shutdown is idempotent", async () => {
    await sharedMCPProcesses.shutdown();
    await sharedMCPProcesses.shutdown(); // Must not throw.
  });

  it("shutdown with no children is a no-op", async () => {
    await sharedMCPProcesses.shutdown(); // No acquire() called.
  });
});

describe("ProcessRegistry pid-file lifecycle", () => {
  it("writes pid file on successful acquire with the spawned child's pid", async () => {
    const child = createMockChildProcess(54321);
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const pidFile = noopPidFile();
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile };

    await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);

    expect(pidFile.write).toHaveBeenCalledTimes(1);
    expect(pidFile.write).toHaveBeenCalledWith("calendar", 54321, expect.any(Number));
  });

  it("does not write pid file when child has no pid", async () => {
    const child = createMockChildProcess();
    Object.defineProperty(child, "pid", { value: undefined });
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const pidFile = noopPidFile();
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile };

    await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger);

    expect(pidFile.write).not.toHaveBeenCalled();
  });

  it("removes pid file when child exits mid-life", async () => {
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const pidFile = noopPidFile();

    await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec(),
      { spawn, fetch: fetchImpl, pidFile },
      fakeLogger,
    );

    child._emitExit(137, null);
    // Allow void pidFile.remove(...) to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(pidFile.remove).toHaveBeenCalledWith("calendar");
  });

  it("removes pid files on shutdown", async () => {
    const calChild = createMockChildProcess(1);
    const gmailChild = createMockChildProcess(2);
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => calChild)
      .mockImplementationOnce(() => gmailChild);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const pidFile = noopPidFile();

    await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec(),
      { spawn, fetch: fetchImpl, pidFile },
      fakeLogger,
    );
    await sharedMCPProcesses.acquire(
      "gmail",
      makeSpec({ readyUrl: "http://localhost:8002/mcp" }),
      { spawn, fetch: fetchImpl, pidFile },
      fakeLogger,
    );

    await sharedMCPProcesses.shutdown();

    const removedIds = (pidFile.remove as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(removedIds).toContain("calendar");
    expect(removedIds).toContain("gmail");
  });

  it("acquire failure does not write pid file (cache evicted before write)", async () => {
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const fetchImpl = vi.fn();
    const pidFile = noopPidFile();
    const deps: ProcessRegistryDeps = { spawn, fetch: fetchImpl, pidFile };

    await sharedMCPProcesses.acquire("calendar", makeSpec(), deps, fakeLogger).catch(() => {});

    expect(pidFile.write).not.toHaveBeenCalled();
  });

  it("pid-file write throwing does not block acquire success", async () => {
    const child = createMockChildProcess();
    const spawn = vi.fn().mockReturnValue(child);
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, ok: true } as Response);
    const pidFile: PidFileWriter = {
      write: vi.fn().mockRejectedValue(new Error("EACCES")),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    const handle = await sharedMCPProcesses.acquire(
      "calendar",
      makeSpec(),
      { spawn, fetch: fetchImpl, pidFile },
      fakeLogger,
    );

    expect(handle.child).toBe(child);
    expect(pidFile.write).toHaveBeenCalled();
  });
});
