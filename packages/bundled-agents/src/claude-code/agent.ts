import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type ArtifactRef, createAgent } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { smallLLM } from "@atlas/llm";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { createSandbox, sandboxOptions } from "./sandbox.ts";

/** Timeout between SDK messages before we consider it stalled (ms) */
const MESSAGE_TIMEOUT_MS = 60_000;

/**
 * Wraps an async iterable with a timeout that resets on each yielded value.
 * Throws if no value is received within the timeout period.
 */
async function* withMessageTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(onTimeout()), timeoutMs)),
    ]);
    if (result.done) break;
    yield result.value;
  }
}

type CCAgentResult = Result<{ response: string; artifactRef: ArtifactRef }, { reason: string }>;

/**
 * Format tool invocation as concise single-line status message (≤50 chars).
 * Used to stream progress updates during code execution.
 */
async function generateProgress(context: unknown, abortSignal?: AbortSignal): Promise<string> {
  const contextStr = typeof context === "string" ? context : JSON.stringify(context, null, 2);

  return await smallLLM({
    system: `Format tool invocation as single-line status. Output only the status line, no explanations.

<rules>
- Single line, ≤50 chars
- Use -ing verbs: Reading, Writing, Executing
- Preserve technical terms, numbers, HTTP codes, filenames
- Abbreviate long paths to filename only (>20 chars)
- Remove articles: the, this, my, a, an
</rules>

<examples>
Write to /tmp/agent-output.txt → "Writing agent-output.txt"
Read package.json → "Reading package.json"
</examples>`,
    prompt: contextStr,
    abortSignal,
    maxOutputTokens: 50,
  });
}

export const claudeCodeAgent = createAgent<string, CCAgentResult>({
  id: "claude-code",
  displayName: "Claude Code",
  version: "1.0.0",
  description: "Execute coding tasks using Claude API with sandboxed filesystem access",
  expertise: {
    domains: ["code-generation", "file-operations", "development"],
    examples: [
      "Write a TypeScript function to parse JSON",
      "Read and analyze the package.json file",
    ],
  },
  environment: {
    required: [
      {
        name: "ANTHROPIC_API_KEY",
        description: "Anthropic API key for Claude API access",
        linkRef: { provider: "anthropic", key: "api_key" },
      },
      {
        name: "GH_TOKEN",
        description: "GitHub PAT for gh CLI access to private repos",
        linkRef: { provider: "github", key: "access_token" },
      },
    ],
  },
  handler: async (prompt, { logger, abortSignal, stream, session, env }) => {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return fail({ reason: "ANTHROPIC_API_KEY not set. Connect Anthropic in Link." });
    }

    const ghToken = env.GH_TOKEN;
    if (!ghToken) {
      return fail({ reason: "GH_TOKEN not set. Connect GitHub in Link." });
    }

    const sandbox = await createSandbox(session.sessionId);

    const controller = new AbortController();
    abortSignal?.addEventListener("abort", () => controller.abort());

    try {
      let responseText = "";

      const sdkStream = query({
        prompt,
        options: {
          // SDK defaults to bundled cli.js which doesn't exist in compiled Deno binaries
          pathToClaudeCodeExecutable: process.env.ATLAS_CLAUDE_PATH,
          cwd: sandbox.workDir,
          model: "claude-sonnet-4-5",
          tools: { type: "preset", preset: "claude_code" },
          disallowedTools: ["Bash(rm -rf:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)"],
          permissionMode: "bypassPermissions",
          settingSources: [],
          maxTurns: 25,
          sandbox: sandboxOptions,
          abortController: controller,
          env: { ...process.env, ANTHROPIC_API_KEY: apiKey, GH_TOKEN: ghToken },
          stderr: (data) => logger.debug("Claude CLI stderr", { data }),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              "You have authenticated access to the gh CLI for GitHub operations. Use it for cloning repos, creating PRs, managing issues, and interacting with GitHub APIs. Return summary of actions. Concise, factual, markdown.",
          },
        },
      });

      const timedStream = withMessageTimeout(
        sdkStream,
        MESSAGE_TIMEOUT_MS,
        () => new Error(`SDK stalled: no message received in ${MESSAGE_TIMEOUT_MS / 1000}s`),
      );

      for await (const message of timedStream) {
        // System init
        if (message.type === "system" && message.subtype === "init") {
          logger.debug("Session started", { sessionId: message.session_id, cwd: message.cwd });
        }

        // Tool progress from assistant messages
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "tool_use") {
              const progress = await generateProgress(
                { toolName: block.name, input: block.input },
                abortSignal,
              );
              stream?.emit({
                type: "data-tool-progress",
                data: { toolName: "Claude Code", content: progress },
              });
            }
          }
        }

        // Final result
        if (message.type === "result") {
          if (message.subtype === "success") {
            // API auth failures have subtype=success but is_error=true
            if (message.is_error) {
              return fail({ reason: message.result || "Execution failed" });
            }

            responseText = message.result;
            logger.debug("Execution complete", {
              cost: message.total_cost_usd,
              turns: message.num_turns,
            });
          } else {
            // Error types: error_max_turns, error_during_execution, etc.
            const errorMsg = message.subtype;
            logger.error("Execution failed", { subtype: errorMsg });
            return fail({ reason: errorMsg });
          }
        }
      }

      // Create artifact
      const artifactResponse = await parseResult(
        client.artifactsStorage.index.$post({
          json: {
            data: { type: "summary" as const, version: 1 as const, data: responseText },
            title: "Claude Code Output",
            summary: `Claude Code: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
          },
        }),
      );

      if (!artifactResponse.ok) {
        return fail({ reason: stringifyError(artifactResponse.error) });
      }

      return success({ response: responseText, artifactRef: artifactResponse.data.artifact });
    } catch (error) {
      logger.error("Claude Code agent failed", { error });
      return fail({ reason: stringifyError(error) });
    } finally {
      await sandbox.cleanup();
    }
  },
});
