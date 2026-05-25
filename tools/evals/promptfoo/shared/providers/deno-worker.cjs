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
//                                         suite's assertions can parse
//        { id, error }                 — handler threw or rejected
//
// Handlers must NOT write to stdout (would corrupt the protocol). The worker
// redirects console.log/info to stderr defensively.

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
      {
        cwd: repoRoot(),
        env: process.env,
        stdio: ["pipe", "pipe", "inherit"],
      },
    );

    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
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
      this.exitErr = new Error(
        `Deno worker exited unexpectedly (code=${code} signal=${signal})`,
      );
      for (const { reject } of this.pending.values()) reject(this.exitErr);
      this.pending.clear();
      this.proc = null;
    });

    // Best-effort cleanup if promptfoo exits without draining
    const killOnce = () => {
      if (this.proc) {
        try {
          this.proc.kill("SIGTERM");
        } catch {}
      }
    };
    process.once("exit", killOnce);
    process.once("SIGINT", killOnce);
    process.once("SIGTERM", killOnce);
  }

  call(payload) {
    this.ensureSpawned();
    if (this.exitErr) return Promise.reject(this.exitErr);

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
  }

  id() {
    return this.label || `deno-worker:${this.config.registryId || "unknown"}`;
  }

  async callApi(prompt, context) {
    const handlerAbsPath = resolveHandler(this.config.handler);
    const worker = getWorker(handlerAbsPath);
    const result = await worker.call({
      prompt,
      vars: (context && context.vars) || {},
      config: this.config,
    });
    return { output: result.output };
  }
}

module.exports = DenoWorkerProvider;
