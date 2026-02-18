import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { registry, smallLLM } from "@atlas/llm";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { generateObject } from "ai";
import { z } from "zod";
import { createSandbox, sandboxOptions } from "./sandbox.ts";

const execFileAsync = promisify(execFile);

/**
 * Schema for extracting repo and task from prompt.
 */
const PrepSchema = z.object({
  repo: z
    .string()
    .nullable()
    .describe("Repository in owner/repo format, or null if no clone instruction"),
  task: z.string().describe("Task with clone instruction removed, or original prompt verbatim"),
});

/**
 * Extract repository and cleaned task from prompt using haiku.
 * If the prompt contains clone instructions, extracts the repo and removes the instruction.
 * Otherwise returns null repo and the original prompt verbatim.
 */
async function extractRepoAndTask(
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<z.infer<typeof PrepSchema>> {
  const { object } = await generateObject({
    model: registry.languageModel("anthropic:claude-haiku-4-5"),
    schema: PrepSchema,
    abortSignal,
    prompt: `Extract repository and task from this prompt.

If the prompt instructs cloning a repository:
- Extract the repo in "owner/repo" format (not a full URL)
- Remove the cloning instruction from the task
- Return the rest of the task verbatim

If no cloning is mentioned: repo is null and task is the original prompt verbatim.

Prompt:
${prompt}`,
  });
  return object;
}

/**
 * Clone a repository using the gh CLI.
 * @param repo - Repository in owner/repo format
 * @param targetDir - Directory to clone into
 * @param ghToken - GitHub token for authentication
 */
async function cloneRepo(
  repo: string,
  targetDir: string,
  ghToken: string,
): Promise<Result<void, string>> {
  try {
    await execFileAsync("gh", ["repo", "clone", repo, targetDir], {
      env: { ...process.env, GH_TOKEN: ghToken },
    });
    return success(undefined);
  } catch (error) {
    return fail(stringifyError(error));
  }
}

/** Base timeout: no SDK messages AND no stderr activity (ms) */
export const MESSAGE_TIMEOUT_MS = 60_000;
/** Extended timeout: no SDK messages but stderr was recently active (ms) */
export const EXTENDED_TIMEOUT_MS = 180_000;

export type ActivityTracker = { lastActivityMs: number };

/**
 * Wraps an async iterable with a tiered stall-detection timeout.
 *
 * Two tiers:
 * - At baseTimeoutMs: check if stderr was active near this wait. If stale
 *   (process cold/dead), reject immediately.
 * - At extendedTimeoutMs: hard cap — always reject. Accommodates subagent
 *   execution where the process was recently alive but goes silent.
 */
export async function* withMessageTimeout<T>(
  iterable: AsyncIterable<T>,
  baseTimeoutMs: number,
  extendedTimeoutMs: number,
  onTimeout: () => Error,
  activity: ActivityTracker,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    const waitStart = Date.now();
    let baseTimer: ReturnType<typeof setTimeout> | undefined;
    let extTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      iterator.next().then((r) => {
        clearTimeout(baseTimer);
        clearTimeout(extTimer);
        activity.lastActivityMs = Date.now(); // message = process alive
        return r;
      }),
      new Promise<never>((_, reject) => {
        baseTimer = setTimeout(() => {
          if (activity.lastActivityMs < waitStart - baseTimeoutMs) {
            clearTimeout(extTimer);
            reject(onTimeout());
          }
        }, baseTimeoutMs);
        extTimer = setTimeout(() => reject(onTimeout()), extendedTimeoutMs);
      }),
    ]);
    if (result.done) break;
    yield result.value;
  }
}

/**
 * Output schema for Claude Code agent - describes the success data shape
 */
export const ClaudeCodeOutputSchema = z.object({
  response: z.string().describe("Claude Code output text"),
});

export type ClaudeCodeAgentResult = z.infer<typeof ClaudeCodeOutputSchema>;

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

export const claudeCodeAgent = createAgent<string, ClaudeCodeAgentResult>({
  id: "claude-code",
  displayName: "Claude Code",
  version: "1.0.0",
  description:
    "Execute coding tasks, analyze codebases, debug issues, and identify root causes using Claude API with sandboxed filesystem access",
  outputSchema: ClaudeCodeOutputSchema,
  expertise: {
    domains: [
      "code-generation",
      "coding",
      "file-operations",
      "development",
      "programming",
      "code-analysis",
      "debugging",
      "root-cause-analysis",
    ],
    examples: [
      "Write a TypeScript function to parse JSON",
      "Read and analyze the package.json file",
      "Analyze stack traces and identify root causes",
      "Debug this error in the codebase",
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
        description: "GitHub token for gh CLI access to private repos",
        linkRef: { provider: "github", key: "access_token" },
      },
    ],
  },
  handler: async (prompt, { logger, abortSignal, stream, session, env }) => {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return err("ANTHROPIC_API_KEY not set. Connect Anthropic in Link.");
    }

    const ghToken = env.GH_TOKEN;
    if (!ghToken) {
      return err("GH_TOKEN not set. Connect GitHub in Link.");
    }

    const sandbox = await createSandbox(session.sessionId);

    const controller = new AbortController();
    abortSignal?.addEventListener("abort", () => controller.abort());

    // Extract repo from prompt and pre-clone if present
    let effectivePrompt = prompt;
    try {
      const prep = await extractRepoAndTask(prompt, abortSignal);
      if (prep.repo) {
        logger.info("Pre-cloning repository", { repo: prep.repo, targetDir: sandbox.workDir });
        const cloneResult = await cloneRepo(prep.repo, sandbox.workDir, ghToken);
        if (cloneResult.ok) {
          effectivePrompt = prep.task;
          logger.info("Pre-clone successful, CLAUDE.md and skills will be loaded", {
            repo: prep.repo,
          });
        } else {
          logger.warn("Pre-clone failed, agent will handle", {
            repo: prep.repo,
            error: cloneResult.error,
          });
        }
      } else {
        logger.debug("No repository detected in prompt, skipping pre-clone");
      }
    } catch (error) {
      logger.warn("Repo extraction failed, using original prompt", {
        error: stringifyError(error),
      });
    }

    try {
      let responseText = "";
      const activity: ActivityTracker = { lastActivityMs: Date.now() };

      const sdkStream = query({
        prompt: effectivePrompt,
        options: {
          // SDK defaults to bundled cli.js which doesn't exist in compiled Deno binaries
          pathToClaudeCodeExecutable: process.env.ATLAS_CLAUDE_PATH,
          cwd: sandbox.workDir,
          model: "claude-sonnet-4-6",
          tools: { type: "preset", preset: "claude_code" },
          disallowedTools: ["Bash(rm -rf:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)"],
          permissionMode: "bypassPermissions",
          settingSources: ["project"],
          maxTurns: 500,
          sandbox: sandboxOptions,
          abortController: controller,
          env: { ...process.env, ANTHROPIC_API_KEY: apiKey, GH_TOKEN: ghToken },
          stderr: (data) => {
            activity.lastActivityMs = Date.now();
            logger.debug("Claude CLI stderr", { data });
          },
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
        EXTENDED_TIMEOUT_MS,
        () => new Error(`SDK stalled: no message received in ${MESSAGE_TIMEOUT_MS / 1000}s`),
        activity,
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
              return err(message.result || "Execution failed");
            }

            responseText = message.result;
            logger.debug("Execution complete", {
              cost: message.total_cost_usd,
              turns: message.num_turns,
            });
          } else {
            // Error types: error_max_turns, error_during_execution, etc.
            logger.error("Execution failed", { subtype: message.subtype });
            return err(message.subtype);
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
        return err(stringifyError(artifactResponse.error));
      }

      const { id, type, summary } = artifactResponse.data.artifact;
      return ok({ response: responseText }, { artifactRefs: [{ id, type, summary }] });
    } catch (error) {
      logger.error("Claude Code agent failed", { error });
      return err(stringifyError(error));
    } finally {
      await sandbox.cleanup();
    }
  },
});
