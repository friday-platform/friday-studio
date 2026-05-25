#!/usr/bin/env -S deno run --allow-all
//
// Long-lived Deno worker for promptfoo custom providers.
//
// Spawned by tools/evals/promptfoo/shared/providers/deno-worker.cjs with
//   --handler <abs-path-to-handler.ts>
// Reads newline-delimited JSON requests from stdin, dispatches to the
// handler's default export, writes responses to stdout (one JSON per line).
//
// Protocol:
//   in:  { id, prompt, vars, config }
//   out: { id, output }                — success
//        { id, error }                 — handler threw or rejected
//
// Handlers MUST NOT write to stdout. console.log/info is redirected to stderr
// defensively below; raw `Deno.stdout.writeSync` from a handler will corrupt
// the protocol.

// Inline `--handler <path>` parse — avoids pulling in @std/cli for one flag.
const handlerFlagIdx = Deno.args.indexOf("--handler");
const handlerArg =
  handlerFlagIdx >= 0 && handlerFlagIdx + 1 < Deno.args.length
    ? Deno.args[handlerFlagIdx + 1]
    : undefined;
if (!handlerArg) {
  console.error("worker.ts: --handler <path> required");
  Deno.exit(1);
}

// Redirect any handler-side console.log/info to stderr so they can't corrupt
// the stdout JSON-Lines protocol. console.error/warn already go to stderr.
const _logToStderr = (...parts: unknown[]) => {
  const text = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  Deno.stderr.writeSync(new TextEncoder().encode(`${text}\n`));
};
console.log = _logToStderr;
console.info = _logToStderr;

// Dynamic-import the per-suite handler. URL form bypasses any cache subtleties.
const handlerAbs = handlerArg.startsWith("/") ? handlerArg : `${Deno.cwd()}/${handlerArg}`;
const handlerUrl = new URL(`file://${handlerAbs}`);
const handlerModule = await import(handlerUrl.href);
const handle = handlerModule.default;
if (typeof handle !== "function") {
  console.error(`worker.ts: ${handlerArg} must export a default async function`);
  Deno.exit(1);
}

interface Request {
  id: string;
  prompt: string;
  vars: Record<string, unknown>;
  config: Record<string, unknown>;
}

interface Response {
  /** Stringified payload the suite's assertions can parse. */
  output: string;
}

// Raw stdout writer — only this function writes to stdout in the whole worker.
const encoder = new TextEncoder();
const writeLine = (msg: unknown) => {
  Deno.stdout.writeSync(encoder.encode(`${JSON.stringify(msg)}\n`));
};

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return "<unstringifiable error>";
  }
}

// Read stdin as a stream of JSON Lines. Handlers run in parallel — we don't
// await each before reading the next request.
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk);
  while (true) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) break;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch (err) {
      console.error(`worker.ts: bad JSON line — ${errorToString(err)}`);
      continue;
    }
    Promise.resolve()
      .then(() => handle(req) as Promise<Response>)
      .then((result) => writeLine({ id: req.id, output: result.output }))
      .catch((err) => writeLine({ id: req.id, error: errorToString(err) }));
  }
}
