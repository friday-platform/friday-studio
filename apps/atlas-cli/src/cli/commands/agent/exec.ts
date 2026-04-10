import process from "node:process";
import { parseSSEStream } from "@atlas/utils/sse";
import { define } from "gunshi";
import { errorOutput } from "../../../utils/output.ts";

const DEFAULT_PLAYGROUND_URL = "http://localhost:5200";

/**
 * Renders a single SSE event to stdout in human-readable format.
 * Returns true if a trailing newline is needed before the next non-delta output.
 */
function renderEvent(
  event: string | undefined,
  data: Record<string, unknown>,
  inTextStream: boolean,
): boolean {
  switch (event) {
    case "progress": {
      const type = data.type as string;
      if (type === "text-delta") {
        const delta = (data.textDelta ?? data.delta ?? "") as string;
        process.stdout.write(delta);
        return true;
      }
      if (type === "text") {
        const text = (data.text ?? "") as string;
        process.stdout.write(text);
        return true;
      }
      if (type === "tool-input-start") {
        if (inTextStream) process.stdout.write("\n");
        console.log(`\x1b[2m[calling ${data.toolName}]\x1b[0m`);
        return false;
      }
      if (type === "tool-output-available") {
        const output = data.output ?? data.result;
        const preview =
          typeof output === "string" ? output.slice(0, 200) : JSON.stringify(output).slice(0, 200);
        console.log(`\x1b[2m[result: ${preview}]\x1b[0m`);
        return false;
      }
      return inTextStream;
    }
    case "error": {
      if (inTextStream) process.stdout.write("\n");
      errorOutput(data.error as string);
      return false;
    }
    case "result": {
      if (inTextStream) process.stdout.write("\n");
      const result = typeof data === "string" ? data : JSON.stringify(data, null, 2);
      console.log(`\n${result}`);
      return false;
    }
    case "done": {
      if (inTextStream) process.stdout.write("\n");
      const parts: string[] = [];
      if (data.durationMs) parts.push(`${Math.round(data.durationMs as number)}ms`);
      if (data.totalTokens) parts.push(`${data.totalTokens} tokens`);
      if (data.stepCount) parts.push(`${data.stepCount} steps`);
      if (parts.length > 0) {
        console.log(`\x1b[2m[done: ${parts.join(", ")}]\x1b[0m`);
      }
      return false;
    }
    case "log": {
      if (inTextStream) process.stdout.write("\n");
      console.log(`\x1b[2m[${data.level}] ${data.message}\x1b[0m`);
      return inTextStream;
    }
    case "artifact": {
      if (inTextStream) process.stdout.write("\n");
      console.log(`\x1b[36m[artifact: ${data.name}]\x1b[0m`);
      return false;
    }
    default:
      return inTextStream;
  }
}

/**
 * Parse --env KEY=VALUE flags into a record.
 */
function parseEnvArgs(envArgs: string | undefined): Record<string, string> | undefined {
  if (!envArgs) return undefined;
  const result: Record<string, string> = {};
  for (const pair of envArgs.split(",")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    result[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export const execCommand = define({
  name: "exec",
  description: "Execute an agent via the playground and stream results",
  args: {
    agent: { type: "positional", description: "Agent ID to execute", required: true },
    input: {
      type: "string",
      short: "i",
      description: "Prompt / input text for the agent",
      required: true,
    },
    json: { type: "boolean", description: "Output raw SSE events as NDJSON", default: false },
    url: { type: "string", description: `Playground URL (default: ${DEFAULT_PLAYGROUND_URL})` },
    env: {
      type: "string",
      short: "e",
      description: "Environment variables as KEY=VALUE,KEY2=VALUE2",
    },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const agentId = ctx.values.agent;
    if (!agentId) {
      errorOutput("Agent ID is required");
      process.exit(1);
    }

    const input = ctx.values.input;
    if (!input) {
      errorOutput("Input is required (--input / -i)");
      process.exit(1);
    }

    const playgroundUrl = ctx.values.url ?? DEFAULT_PLAYGROUND_URL;
    const env = parseEnvArgs(ctx.values.env);
    const jsonMode = ctx.values.json;

    const body = JSON.stringify({ agentId, input, env });

    let response: Response;
    try {
      response = await fetch(`${playgroundUrl}/api/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch {
      errorOutput(
        `Could not connect to playground at ${playgroundUrl}. Is it running? (deno task playground)`,
      );
      process.exit(1);
    }

    if (!response.ok) {
      const text = await response.text();
      errorOutput(`Playground returned ${response.status}: ${text}`);
      process.exit(1);
    }

    if (!response.body) {
      errorOutput("No response body from playground");
      process.exit(1);
    }

    let inTextStream = false;

    for await (const message of parseSSEStream(response.body)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(message.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (jsonMode) {
        console.log(JSON.stringify({ event: message.event, data }));
      } else {
        inTextStream = renderEvent(message.event, data, inTextStream);
      }
    }

    // Ensure terminal newline after streaming text
    if (inTextStream) process.stdout.write("\n");
  },
});
