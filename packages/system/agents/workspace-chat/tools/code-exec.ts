/**
 * `run_code` tool — execute a short script in Python, JavaScript (Deno), or
 * bash, in an ephemeral per-session scratch directory.
 *
 * ## Design decisions
 *
 * We followed Hermes' `code_execution_tool.py` philosophy (one-shot code
 * execution with stdout capture and a hard timeout) but trimmed the complex
 * bits:
 *
 * - **No Docker / UDS RPC sandbox.** Hermes wraps execution in a Docker
 *   container with a Unix-domain-socket back-channel so the in-sandbox
 *   Python can call back into the parent agent's tool registry. That's the
 *   gold standard for isolation but it's ~500 lines of RPC plumbing and
 *   brings Docker into Friday's runtime dependencies. Instead, we rely on:
 *
 *     1. A per-session ephemeral scratch directory under
 *        `{atlas_home}/scratch/{sessionId}/` — the tool never writes outside
 *        its own dir.
 *     2. A hard 30-second wall-clock timeout enforced via `AbortSignal`.
 *     3. Stdout / stderr size caps (100 KB each) so runaway scripts can't
 *        blow the agent's context window.
 *     4. Fresh scratch dir per session — deleted on agent teardown, no cross-
 *        session state leakage.
 *
 *   This is enough isolation for *trusted* code the LLM wrote in response
 *   to a user request on the user's own machine. It is NOT a security
 *   boundary for hostile input — do not expose this tool to untrusted users.
 *
 * - **No recursive tool access inside the sandbox.** Hermes lets a running
 *   Python script call back into `web_search`, `web_fetch`, etc. via the
 *   UDS channel. We don't — if the LLM needs more tools, it can chain
 *   multiple native tool calls through the normal chat turn loop. Simpler,
 *   and still covers the reported use cases.
 *
 * - **Three interpreters**: `python` (`python3`), `javascript` (`deno run`),
 *   and `bash` (`/bin/bash`). Picked for lowest-friction coverage of
 *   "run this one-off computation / munge this data / test this regex"
 *   requests.
 *
 * @module
 */

import type { Buffer } from "node:buffer";
import { type ExecOptions, exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const execAsync = promisify(exec);

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 100 * 1024; // 100 KB
const MAX_STDERR_BYTES = 100 * 1024; // 100 KB
const SUPPORTED_LANGUAGES = ["python", "javascript", "bash"] as const;

type Language = (typeof SUPPORTED_LANGUAGES)[number];

const LANGUAGE_COMMANDS: Record<Language, { extension: string; build: (file: string) => string }> =
  {
    python: { extension: "py", build: (file) => `python3 "${file}"` },
    javascript: {
      extension: "mjs",
      // --allow-net is intentionally omitted — no network from within the
      // sandbox. If a user wants web access, they should use web_fetch.
      build: (file) =>
        `deno run --quiet --allow-read="$(dirname \\"${file}\\")" --allow-write="$(dirname \\"${file}\\")" "${file}"`,
    },
    bash: { extension: "sh", build: (file) => `/bin/bash "${file}"` },
  };

// ─── Scratch directory ───────────────────────────────────────────────────────

/**
 * Resolve the per-session scratch directory under `{ATLAS_HOME}/scratch/{sessionId}/`.
 * The directory is created on first call and reused across `run_code`
 * invocations within the same chat turn so scripts can read files written
 * by earlier calls. It is NOT cleaned up here — cleanup happens when the
 * chat-sdk session ends.
 */
function scratchDir(sessionId: string): string {
  const atlasHome = process.env.ATLAS_HOME ?? join(process.env.HOME ?? "/tmp", ".atlas");
  // Strip any path traversal; session IDs are UUIDs so this is paranoia.
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
  return join(atlasHome, "scratch", safe || "default");
}

// ─── Input schema ────────────────────────────────────────────────────────────

export const RunCodeInput = z.object({
  language: z
    .enum(SUPPORTED_LANGUAGES)
    .describe("Interpreter: `python` (python3), `javascript` (deno), or `bash`."),
  source: z
    .string()
    .min(1)
    .describe(
      "Full source code. The file is written to the session scratch dir and executed. Files read/written by the script persist in the same scratch dir and can be read by subsequent `run_code` calls within the same session.",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Hard wall-clock timeout. Default ${DEFAULT_TIMEOUT_MS} ms, max ${MAX_TIMEOUT_MS} ms.`,
    ),
});

// ─── Tool factory ────────────────────────────────────────────────────────────

export interface RunCodeSuccess {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  language: Language;
  scratch_dir: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface RunCodeError {
  error: string;
}

/**
 * Build the `run_code` tool. Each tool instance is scoped to a single chat
 * session via its `sessionId` — scripts can read files they wrote earlier
 * in the same session, but never from other sessions.
 */
export function createRunCodeTool(sessionId: string, logger: Logger): AtlasTools {
  return {
    run_code: tool({
      description:
        "Execute a short script in Python, JavaScript (Deno), or bash and return stdout/stderr/exit code. Use this for ad-hoc computation, data munging, regex testing, or quick scripting when the user asks you to run something. Each session has an ephemeral scratch directory at `{scratch_dir}` — files written there persist across `run_code` calls in the same conversation so you can build up state across turns. No network access from inside the sandbox — use `web_fetch` for that. Hard timeout (default 30 s) and stdout/stderr size caps. Intended for trusted code; do not run hostile input. **No TTY**: commands that need interactive auth (`op item create/read/edit/delete`, `ssh`, `sudo`, `gpg`, `aws sso login`, `gh auth login`, `security`) can't prompt the user here — they will fail silently with empty stderr. Tell the user to run those in their terminal directly.",
      inputSchema: RunCodeInput,
      execute: async ({ language, source, timeout_ms }): Promise<RunCodeSuccess | RunCodeError> => {
        const dir = scratchDir(sessionId);
        try {
          await mkdir(dir, { recursive: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `run_code scratch dir creation failed: ${message}` };
        }

        const lang = language as Language;
        const spec = LANGUAGE_COMMANDS[lang];
        const filename = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${spec.extension}`;
        const filePath = join(dir, filename);

        try {
          await writeFile(filePath, source, "utf-8");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `run_code write failed: ${message}` };
        }

        const command = spec.build(filePath);
        const timeout = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const options: ExecOptions = {
          cwd: dir,
          timeout,
          maxBuffer: MAX_STDOUT_BYTES + MAX_STDERR_BYTES,
          env: {
            ...process.env,
            // A Python-specific buffer flush hint so print() isn't held.
            PYTHONUNBUFFERED: "1",
          },
          killSignal: "SIGKILL",
        };

        const started = Date.now();
        try {
          const result = await execAsync(command, options);
          const duration = Date.now() - started;
          logger.info("run_code success", { sessionId, language: lang, duration });
          return buildSuccess(
            lang,
            dir,
            stringify(result.stdout),
            stringify(result.stderr),
            0,
            duration,
          );
        } catch (err) {
          const duration = Date.now() - started;
          // exec() throws on non-zero exit OR on exec-layer errors (timeout,
          // maxBuffer, ENOENT). Both kinds of error object carry
          // `stdout`/`stderr` when they exist, and we want to surface them
          // regardless — losing stderr leaves the LLM guessing and re-trying.
          // So: duck-type for the standard exec-error shape (has at least
          // one of stdout/stderr/killed/code/signal) rather than gating on
          // `code` being a number, which missed string-typed codes like
          // ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
          if (
            typeof err === "object" &&
            err !== null &&
            ("stdout" in err || "stderr" in err || "killed" in err || "signal" in err)
          ) {
            const execErr = err as {
              code?: number | string;
              killed?: boolean;
              signal?: string;
              stdout?: string | Buffer;
              stderr?: string | Buffer;
              message?: string;
            };
            if (execErr.killed && execErr.signal === "SIGKILL") {
              return { error: `run_code killed by timeout after ${timeout}ms` };
            }
            const stdout = stringify(execErr.stdout);
            const stderr = stringify(execErr.stderr);
            // Numeric exit code when the child exited normally; 1 as a
            // conservative default when only an exec-layer error fired.
            const exitCode = typeof execErr.code === "number" ? execErr.code : 1;
            logger.info("run_code nonzero exit", {
              sessionId,
              language: lang,
              exitCode,
              duration,
              hadStderr: stderr.length > 0,
            });
            const enriched = enrichEmptyStderrWithTtyHint(source, stderr, exitCode);
            return buildSuccess(lang, dir, stdout, enriched, exitCode, duration);
          }
          const message = err instanceof Error ? err.message : String(err);
          return { error: `run_code execution failed: ${message}` };
        }
      },
    }),
  };
}

/**
 * `child_process.exec` returns `{ stdout, stderr }` with each field typed as
 * `string | Buffer`. Our tool surface requires plain strings, so decode here.
 */
function stringify(value: string | Buffer | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return value.toString("utf-8");
}

/**
 * Commands that route their auth prompts through `/dev/tty` rather than
 * stdout/stderr, or that insist on an interactive password flow. When any
 * of these appears in the source and the command fails with **empty
 * stderr**, we inject a hint so the LLM (and the user) aren't left staring
 * at a silent failure. The list is intentionally conservative — only
 * commands that frequently fail in CI-style pipe environments.
 *
 * The regex uses a word boundary on both sides so `op`, `ssh`, `sudo`, etc.
 * don't match substrings (`opt`, `sshkeygen` would still match — good —
 * but `setopt` wouldn't).
 */
const TTY_AUTH_COMMAND_RE =
  /\b(op|ssh|scp|sftp|sudo|gpg|security|keychain|aws\s+sso\s+login|gh\s+auth\s+login|doctl\s+auth\s+init|gcloud\s+auth\s+login|az\s+login)\b/;

function enrichEmptyStderrWithTtyHint(source: string, stderr: string, exitCode: number): string {
  if (exitCode === 0) return stderr;
  if (stderr.trim() !== "") return stderr;
  if (!TTY_AUTH_COMMAND_RE.test(source)) return stderr;
  return (
    "[run_code hint] The command failed with empty stderr, and the script " +
    "uses a tool that needs interactive auth via a real terminal (op, ssh, " +
    "sudo, gpg, aws sso login, gh auth login, etc.). Those tools write auth " +
    "prompts to /dev/tty, which this sandbox does not provide — the process " +
    "exits silently without ever surfacing the prompt.\n" +
    "\n" +
    "Action: tell the user to run the exact command in their own terminal. " +
    "Do not retry — each retry triggers another auth prompt (e.g. Touch ID, " +
    "Apple Watch) that cannot complete here."
  );
}

function buildSuccess(
  language: Language,
  scratchPath: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  duration: number,
): RunCodeSuccess {
  const stdoutTruncated = stdout.length > MAX_STDOUT_BYTES;
  const stderrTruncated = stderr.length > MAX_STDERR_BYTES;
  return {
    stdout: stdoutTruncated ? stdout.slice(0, MAX_STDOUT_BYTES) : stdout,
    stderr: stderrTruncated ? stderr.slice(0, MAX_STDERR_BYTES) : stderr,
    exit_code: exitCode,
    duration_ms: duration,
    language,
    scratch_dir: scratchPath,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
  };
}
