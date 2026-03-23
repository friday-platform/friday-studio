/**
 * PTY WebSocket server for the CLI cheatsheet terminal.
 *
 * Speaks restty's WebSocket protocol:
 *   Client → Server: { type: "input", data: string } | { type: "resize", cols, rows }
 *   Server → Client: binary PTY output | { type: "status", shell } | { type: "exit", code }
 *
 * HTTP /health endpoint for readiness checks.
 *
 * Usage:
 *   deno run -A tools/pty-server/server.ts
 *   PTY_PORT=7681 deno run -A tools/pty-server/server.ts
 */

import { Buffer } from "node:buffer";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { type IPty, spawn } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";

const PORT = parseInt(process.env.PTY_PORT ?? "7681", 10);
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_BIN = resolve(__dirname, "bin");

/** Prepend local bin/ to PATH only when there's no system `atlas` binary. */
const hasAtlasBinary = (() => {
  try {
    execSync("which atlas", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

const httpServer = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, CORS_HEADERS);
  res.end("Not found");
});

const wss = new WebSocketServer({ server: httpServer, path: "/pty" });

wss.on("connection", (ws, req) => {
  const params = new URL(req.url ?? "/", "http://localhost").searchParams;
  const shell = process.env.PTY_SHELL ?? process.env.SHELL ?? "/bin/bash";
  const cols = parseInt(params.get("cols") ?? "80", 10);
  const rows = parseInt(params.get("rows") ?? "24", 10);
  const cwd = params.get("cwd") ?? process.env.PTY_CWD ?? process.cwd();

  const ptyEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) ptyEnv[k] = v;
  }
  if (!hasAtlasBinary) {
    ptyEnv.PATH = `${LOCAL_BIN}:${ptyEnv.PATH ?? ""}`;
  }
  ptyEnv.PS1 = "$ ";
  ptyEnv.PROMPT = "$ ";
  ptyEnv.ENV = "";

  let term: IPty;
  try {
    const shellArgs = shell.endsWith("/zsh")
      ? ["-f"]
      : shell.endsWith("/bash")
        ? ["--norc", "--noprofile"]
        : [];
    term = spawn(shell, shellArgs, { name: "xterm-256color", cols, rows, cwd, env: ptyEnv });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: String(err) }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: "status", shell }));

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data), { binary: true });
    }
  });

  term.onExit(({ exitCode }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      ws.close();
    }
  });

  ws.on("message", (raw) => {
    try {
      const parsed: unknown = JSON.parse(String(raw));
      if (typeof parsed !== "object" || parsed === null) return;
      if (!("type" in parsed)) return;

      if (parsed.type === "input" && "data" in parsed && typeof parsed.data === "string") {
        term.write(parsed.data);
      } else if (parsed.type === "resize" && "cols" in parsed && "rows" in parsed) {
        term.resize(parseInt(String(parsed.cols), 10), parseInt(String(parsed.rows), 10));
      }
    } catch {
      // Ignore malformed messages
    }
  });

  ws.on("close", () => {
    try {
      term.kill();
    } catch {
      // Process may already be dead
    }
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[pty-server] Listening on :${PORT}`);
});
