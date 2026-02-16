#!/usr/bin/env -S deno run --allow-all
/**
 * Playground server for the proto pipeline.
 *
 * Serves an interactive HTML visualizer and proxies pipeline execution.
 * Streams progress via SSE, delivers artifacts as they appear in the run directory.
 *
 * Usage: deno run --allow-all tools/workspace-simulator/playground.ts
 *        Then open http://localhost:3456
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (!import.meta.dirname) throw new Error("import.meta.dirname unavailable");
const PROTO_DIR = resolve(import.meta.dirname);
const PROJECT_ROOT = resolve(PROTO_DIR, "../..");
const RUNS_DIR = join(PROTO_DIR, "runs");

const ARTIFACT_FILES = [
  "phase1.json",
  "phase2.json",
  "pipeline-context.json",
  "phase3.json",
  "fsm.json",
  "workspace.yml",
  "execution-report.json",
  "summary.txt",
  "readiness.json",
];

Deno.serve({ port: 3456 }, async (req) => {
  const url = new URL(req.url);

  // Live-reload SSE — client connects, server restart drops the connection,
  // client detects close and reloads the page.
  if (url.pathname === "/livereload") {
    const stream = new ReadableStream({
      start(controller) {
        const id = setInterval(
          () => controller.enqueue(new TextEncoder().encode(": keepalive\n\n")),
          10_000,
        );
        req.signal.addEventListener("abort", () => clearInterval(id));
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  // Serve playground HTML
  if (url.pathname === "/") {
    const html = readFileSync(join(PROTO_DIR, "playground.html"), "utf-8");
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // List available runs
  if (url.pathname === "/api/runs") {
    if (!existsSync(RUNS_DIR)) return Response.json([]);
    const entries = readdirSync(RUNS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, 30)
      .map((e) => {
        const summaryPath = join(RUNS_DIR, e.name, "summary.txt");
        const summary = existsSync(summaryPath)
          ? readFileSync(summaryPath, "utf-8").split("\n")[0]
          : "(no summary)";
        return { slug: e.name, summary };
      });
    return Response.json(entries);
  }

  // Load a specific run's artifacts
  if (url.pathname.startsWith("/api/run/") && req.method === "GET") {
    const slug = decodeURIComponent(url.pathname.slice("/api/run/".length));
    const runDir = join(RUNS_DIR, slug);
    if (!existsSync(runDir)) {
      return Response.json({ error: "Run not found" }, { status: 404 });
    }
    return Response.json(loadRunArtifacts(runDir));
  }

  // Execute pipeline via SSE stream
  if (url.pathname === "/api/run" && req.method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const prompt = body.prompt as string;
    if (!prompt) {
      return Response.json({ error: "Missing prompt" }, { status: 400 });
    }
    return streamPipeline({ args: [prompt], real: body.real === true });
  }

  return new Response("Not Found", { status: 404 });
});

console.log("\n  Workspace Simulator Playground running at http://localhost:3456\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadRunArtifacts(runDir: string): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {};
  for (const file of ARTIFACT_FILES) {
    const path = join(runDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      artifacts[file] = file.endsWith(".json") ? JSON.parse(content) : content;
    }
  }
  return artifacts;
}

function findNewestRunDir(): string | null {
  if (!existsSync(RUNS_DIR)) return null;
  const entries = readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name));
  const newest = entries[0];
  return newest ? join(RUNS_DIR, newest.name) : null;
}

/**
 * Options for streaming a pipeline execution.
 *
 * @param args - CLI positional args (prompt string)
 * @param real - Use real agents via direct MCP execution
 */
interface StreamPipelineOptions {
  args: string[];
  real?: boolean;
}

function streamPipeline(opts: StreamPipelineOptions): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Stream may have been closed by the client
        }
      };

      const beforeNewest = findNewestRunDir();

      const cliArgs = ["run", "--allow-all", "tools/workspace-simulator/cli.ts", ...opts.args];
      if (opts.real) cliArgs.push("--real");

      const mode = opts.real ? "real" : "mock";
      send("log", { text: `Mode: ${mode}`, stderr: false });

      const proc = new Deno.Command("deno", {
        args: cliArgs,
        stdout: "piped",
        stderr: "piped",
        cwd: PROJECT_ROOT,
      }).spawn();

      // Read lines from a stream, sending each as a log event
      const readLines = async (readable: ReadableStream<Uint8Array>, isStderr: boolean) => {
        const reader = readable.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            send("log", { text: line, stderr: isStderr });
          }
        }
        if (buffer.trim()) send("log", { text: buffer, stderr: isStderr });
      };

      const sentArtifacts = new Set<string>();
      let runDir = "";

      const pollId = setInterval(() => {
        // Detect the run directory once it appears (fresh runs only)
        if (!runDir) {
          const newest = findNewestRunDir();
          if (newest && newest !== beforeNewest) {
            runDir = newest;
          }
          return;
        }

        // Stream artifacts as they appear
        for (const file of ARTIFACT_FILES) {
          if (sentArtifacts.has(file)) continue;
          const path = join(runDir, file);
          if (!existsSync(path)) continue;
          try {
            const content = readFileSync(path, "utf-8");
            const data = file.endsWith(".json") ? JSON.parse(content) : content;
            send("artifact", { name: file, data });
            sentArtifacts.add(file);
          } catch {
            // File may still be partially written
          }
        }
      }, 400);

      // Start reading output streams
      const stdoutDone = readLines(proc.stdout, false);
      const stderrDone = readLines(proc.stderr, true);

      await Promise.all([stdoutDone, stderrDone]);
      const status = await proc.status;

      clearInterval(pollId);

      // Final sweep — send any artifacts that were missed during polling
      if (runDir) {
        for (const file of ARTIFACT_FILES) {
          if (sentArtifacts.has(file)) continue;
          const path = join(runDir, file);
          if (!existsSync(path)) continue;
          try {
            const content = readFileSync(path, "utf-8");
            const data = file.endsWith(".json") ? JSON.parse(content) : content;
            send("artifact", { name: file, data });
          } catch {
            // ignore
          }
        }
      }

      send("done", { exitCode: status.code, runDir });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
