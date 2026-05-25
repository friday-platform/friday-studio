// Node CommonJS shim that bridges promptfoo (Node) to a long-lived Deno
// worker. Each `id: file://.../deno-worker.cjs` provider instance spawns ONE
// `deno run worker.ts --handler <path>` subprocess on first call, then talks
// JSON-Lines over stdin/stdout for the lifetime of the process.
//
// Why long-lived (vs spawn-per-call): @atlas/llm + AI SDK imports take
// ~200-400 ms cold. At 30+ eval rows across the workspace-chat suites,
// spawn-per-call would pay that cost on every row. One spawn per provider
// instance amortizes it to once per (suite × tier).
//
// Protocol (JSON Lines, newline-delimited):
//   in:  { id, prompt, vars, config }
//   out: { id, output }                — success; output is a string the
//                                         suite's assertions can parse.
//                                         Additional fields on the success
//                                         line (e.g. tokenUsage, metadata)
//                                         are forwarded into the
//                                         ProviderResponse — see callApi.
//        { id, error }                 — handler threw or rejected
//
// Handlers must NOT write to stdout (would corrupt the protocol). The worker
// redirects console.log/info to stderr defensively.
//
// callApi returns the documented promptfoo ProviderResponse shape:
//   { output, error?, tokenUsage?, metadata? }
// Worker-side failures surface as { output: null, error } — never as a
// rejected promise — so promptfoo records them as scored failures instead
// of uncaught runtime exceptions.

const path = require("node:path");
const process = require("node:process");
const { spawn } = require("node:child_process");

function repoRoot() {
  // .cjs lives at tools/evals/promptfoo/shared/providers/deno-worker.cjs
  return path.resolve(__dirname, "../../../../..");
}

class DenoWorker {
  constructor(handlerAbsPath) {
    this.handlerAbsPath = handlerAbsPath;
    this.proc = null;
    this.pending = new Map();
    this.buffer = "";
    this.nextId = 1;
    this.exitErr = null;
  }

  ensureSpawned() {
    if (this.proc) return;
    // Fail-fast: once a worker dies, every subsequent call surfaces the
    // exit reason. No respawn — a dead worker means the handler itself is
    // broken (bad import, crash on first request, etc.), and silently
    // respawning would hide that while still failing every call.
    if (this.exitErr) throw this.exitErr;
    const workerScript = path.join(__dirname, "worker.ts");
    this.proc = spawn(
      "deno",
      [
        "run",
        "--allow-all",
        "--unstable-worker-options",
        "--unstable-kv",
        "--unstable-raw-imports",
        workerScript,
        "--handler",
        this.handlerAbsPath,
      ],
      { cwd: repoRoot(), env: process.env, stdio: ["pipe", "pipe", "inherit"] },
    );

    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const nl = this.buffer.indexOf("\n");
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stderr.write(`[deno-worker] non-JSON stdout line: ${line}\n`);
          continue;
        }
        const handler = this.pending.get(msg.id);
        if (!handler) {
          process.stderr.write(`[deno-worker] response for unknown id: ${msg.id}\n`);
          continue;
        }
        this.pending.delete(msg.id);
        if (msg.error) handler.reject(new Error(msg.error));
        else handler.resolve(msg);
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.exitErr = new Error(`Deno worker exited unexpectedly (code=${code} signal=${signal})`);
      for (const { reject } of this.pending.values()) reject(this.exitErr);
      this.pending.clear();
      this.proc = null;
    });

    // Best-effort cleanup if promptfoo exits without draining
    const killOnce = () => {
      if (this.proc) {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          // Worker already gone — nothing to clean up.
        }
      }
    };
    process.once("exit", killOnce);
    process.once("SIGINT", killOnce);
    process.once("SIGTERM", killOnce);
  }

  call(payload) {
    try {
      this.ensureSpawned();
    } catch (err) {
      return Promise.reject(err);
    }

    const id = `req-${this.nextId++}`;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    return promise;
  }
}

// One worker per (handler path) — multiple provider entries pointing at the
// same handler share a single worker process for cache efficiency.
const workers = new Map();
function getWorker(handlerAbsPath) {
  if (!workers.has(handlerAbsPath)) {
    workers.set(handlerAbsPath, new DenoWorker(handlerAbsPath));
  }
  return workers.get(handlerAbsPath);
}

function resolveHandler(handlerStr) {
  if (!handlerStr) throw new Error("deno-worker provider: config.handler is required");
  const raw = handlerStr.startsWith("file://") ? handlerStr.slice("file://".length) : handlerStr;
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot(), raw);
}

class DenoWorkerProvider {
  constructor(options) {
    this.options = options ?? {};
    this.config = this.options.config ?? {};
    this.label = this.options.label;
    // Cache the id at construction time so it's stable across calls and not
    // sensitive to mutation of label/config later. `options.id` is what
    // promptfoo passes from the YAML `id:` field — preferred over label so
    // `--filter-providers` matches the user-written id verbatim.
    this._id = this.options.id || this.label || `deno-worker:${this.config.handler || "unknown"}`;
  }

  id() {
    return this._id;
  }

  async callApi(prompt, context) {
    const startedAt = Date.now();
    let handlerAbsPath;
    try {
      handlerAbsPath = resolveHandler(this.config.handler);
    } catch (err) {
      return {
        output: null,
        error: err instanceof Error ? err.message : String(err),
        metadata: { handler: this.config.handler, responseTimeMs: Date.now() - startedAt },
      };
    }

    const worker = getWorker(handlerAbsPath);
    try {
      const result = await worker.call({ prompt, vars: context?.vars || {}, config: this.config });
      const responseTimeMs = Date.now() - startedAt;
      // Forward any extra fields the worker emitted (besides id/output) under
      // metadata so handlers can surface debug info without changing this shim.
      const { id: _id, output, tokenUsage, ...extras } = result;
      const response = { output, metadata: { handler: handlerAbsPath, responseTimeMs, ...extras } };
      if (tokenUsage) response.tokenUsage = tokenUsage;
      return response;
    } catch (err) {
      return {
        output: null,
        error: err instanceof Error ? err.message : String(err),
        metadata: { handler: handlerAbsPath, responseTimeMs: Date.now() - startedAt },
      };
    }
  }
}

module.exports = DenoWorkerProvider;
