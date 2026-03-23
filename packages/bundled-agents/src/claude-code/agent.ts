import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { type HookCallback, query } from "@anthropic-ai/claude-agent-sdk";
import { createAgent, err, ok } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { registry, smallLLM, traceModel } from "@atlas/llm";
import { fail, type Result, stringifyError, success, truncateUnicode } from "@atlas/utils";
import { generateObject } from "ai";
import { z } from "zod";
import { createSandbox, sandboxOptions } from "./sandbox.ts";

const execFileAsync = promisify(execFile);

/**
 * Schema for extracting repo, task, and effort from prompt.
 */
const PrepSchema = z.object({
  repo: z
    .string()
    .nullable()
    .describe("Repository in owner/repo format, or null if no clone instruction"),
  task: z.string().describe("Task with clone instruction removed, or original prompt verbatim"),
  effort: z
    .enum(["low", "medium", "high"])
    .describe(
      "Task complexity: low=read/query/explain, medium=focused edits/single-file changes, high=multi-file refactors/debugging/complex architecture",
    ),
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
    model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
    schema: PrepSchema,
    abortSignal,
    maxRetries: 3,
    prompt: `Extract repository, task, and effort level from this prompt.

If the prompt instructs cloning a repository:
- Extract the repo in "owner/repo" format (not a full URL)
- Remove the cloning instruction from the task
- Return the rest of the task verbatim

If no cloning is mentioned: repo is null and task is the original prompt verbatim.

Classify effort:
- low: reading files, explaining code, answering questions, simple queries
- medium: focused edits, single-file changes, small bug fixes, adding tests
- high: multi-file refactors, complex debugging, architecture changes, large features

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

/**
 * Select primary model and fallback based on effort classification.
 * High-effort tasks get Opus (deeper reasoning), others get Sonnet (faster, cheaper).
 * Haiku is the universal last-resort fallback.
 */
export function selectModel(effort: "low" | "medium" | "high"): {
  model: string;
  fallbackModel: string;
} {
  if (effort === "high") {
    return { model: "claude-opus-4-6", fallbackModel: "claude-sonnet-4-6" };
  }
  return { model: "claude-sonnet-4-6", fallbackModel: "claude-haiku-4-5" };
}

/** Stall timeout: safety net for actual process freezes (ms). With includePartialMessages enabled,
 * the SDK streams token-level events during LLM generation, so activity is continuous. This timeout
 * only triggers on genuine process hangs — not normal thinking pauses. */
export const MESSAGE_TIMEOUT_MS = 600_000; // 10 minutes — safety net, not a balance point

/** How often to check for stall conditions (ms) */
const STALL_CHECK_INTERVAL_MS = 5_000;

export type ActivityTracker = { lastActivityMs: number };

/**
 * Wraps an async iterable with activity-based stall detection.
 *
 * Polls at regular intervals and only rejects when there has been no activity
 * (neither stream messages nor stderr output) for `timeoutMs`. This correctly
 * handles long-running subagent execution where the outer process is alive but
 * silent on both stdout and stderr for extended periods — as long as ANY
 * activity occurs within the timeout window, the check resets.
 */
export async function* withMessageTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  activity: ActivityTracker,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      let intervalId: ReturnType<typeof setInterval> | undefined;
      const cleanup = () => {
        if (intervalId !== undefined) {
          clearInterval(intervalId);
          intervalId = undefined;
        }
      };

      const mappedNext = iterator.next().then(
        (r) => {
          cleanup();
          activity.lastActivityMs = Date.now(); // message = process alive
          return r;
        },
        (e: unknown) => {
          cleanup();
          throw e;
        },
      );
      // Suppress unhandled rejection if timeout wins the race and iterator later rejects
      mappedNext.catch(() => {});

      const result = await Promise.race([
        mappedNext,
        new Promise<never>((_, reject) => {
          const checkMs = Math.min(timeoutMs, STALL_CHECK_INTERVAL_MS);
          intervalId = setInterval(() => {
            if (Date.now() - activity.lastActivityMs >= timeoutMs) {
              cleanup();
              reject(onTimeout());
            }
          }, checkMs);
        }),
      ]);
      if (result.done) break;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}

/**
 * Creates a hook callback that updates the activity tracker — acts as keepalive for stall detection.
 */
export function createKeepalive(activity: ActivityTracker): HookCallback {
  return () => {
    activity.lastActivityMs = Date.now();
    return Promise.resolve({ continue: true });
  };
}

/**
 * Attempt to parse structured output from the SDK response.
 * Returns the parsed record if valid JSON object, undefined otherwise.
 */
export function parseStructuredOutput(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
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
    maxOutputTokens: 250,
  });
}

export const claudeCodeAgent = createAgent<string, ClaudeCodeAgentResult | Record<string, unknown>>(
  {
    id: "claude-code",
    displayName: "Claude Code",
    version: "1.0.0",
    description:
      "Execute coding tasks in a sandboxed environment via Claude Code SDK. Clones repos, reads/writes files, runs commands, analyzes codebases, and debugs issues. USE FOR: code generation, code changes, codebase analysis, debugging, root cause analysis.",
    constraints:
      "Runs in isolated sandbox. Requires Anthropic API key and GitHub token. Cannot access workspace resource tables or artifacts directly. For reading GitHub data (PRs, issues, commits, repos), use the github MCP server. For data analysis, use data-analyst.",
    outputSchema: ClaudeCodeOutputSchema,
    useWorkspaceSkills: true,
    expertise: {
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
    handler: async (
      prompt,
      { logger, abortSignal, stream, session, env, config, outputSchema, skills },
    ) => {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return err("ANTHROPIC_API_KEY not set. Connect Anthropic in Link.");
      }

      const ghToken = env.GH_TOKEN;
      if (!ghToken) {
        return err("GH_TOKEN not set. Connect GitHub in Link.");
      }

      const controller = new AbortController();
      abortSignal?.addEventListener("abort", () => controller.abort(), { once: true });

      // If a prior FSM step (gh/bb agent) already cloned the repo, the runtime
      // passes the clone path as config.workDir. Use it directly instead of
      // creating a fresh sandbox and re-cloning.
      const existingWorkDir = typeof config?.workDir === "string" ? config.workDir : undefined;

      // When a prior FSM step already cloned the repo, reuse it and skip
      // sandbox creation. Still run Haiku extraction for effort classification.
      const [sandbox, prep] = existingWorkDir
        ? await Promise.all([
            Promise.resolve({
              workDir: existingWorkDir,
              // Do NOT clean up — the caller (workspace pipeline) owns this directory.
              // Other steps (e.g. repo-push) may still need it after claude-code finishes.
              cleanup: () => Promise.resolve(),
            }),
            extractRepoAndTask(prompt, abortSignal).catch((error: unknown) => {
              logger.warn("Repo extraction failed, using original prompt", {
                error: stringifyError(error),
              });
              return undefined;
            }),
          ])
        : await Promise.all([
            createSandbox(session.sessionId),
            extractRepoAndTask(prompt, abortSignal).catch((error: unknown) => {
              logger.warn("Repo extraction failed, using original prompt", {
                error: stringifyError(error),
              });
              return undefined;
            }),
          ]);

      // Apply extraction results: repo cloning and effort classification
      let effectivePrompt = prompt;
      let effort: "low" | "medium" | "high" = "medium";
      if (existingWorkDir) {
        if (prep) effort = prep.effort;
        logger.info("Using clone from previous FSM step", { workDir: existingWorkDir, effort });
      } else if (prep) {
        effort = prep.effort;
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
      }

      // Write workspace skills to sandbox for SDK native Skill tool discovery.
      // Written AFTER cloneRepo so repo's own .claude/skills/ are preserved alongside.
      if (skills && skills.length > 0) {
        for (const skill of skills) {
          const skillDir = join(sandbox.workDir, ".claude", "skills", skill.name);
          await mkdir(skillDir, { recursive: true });
          await writeFile(
            join(skillDir, "SKILL.md"),
            `---\nname: ${skill.name}\ndescription: ${skill.description}\nuser-invocable: false\n---\n\n${skill.instructions}`,
          );
        }
        logger.info("Wrote workspace skills to sandbox", {
          count: skills.length,
          names: skills.map((s) => s.name),
        });
      }

      let sdkStream: ReturnType<typeof query> | undefined;
      try {
        let responseText = "";
        let structuredOutput: unknown;
        const activity: ActivityTracker = { lastActivityMs: Date.now() };

        const keepalive = createKeepalive(activity);

        const { model, fallbackModel } = selectModel(effort);

        logger.info("Starting SDK query", { effort, model, fallbackModel });

        sdkStream = query({
          prompt: effectivePrompt,
          options: {
            // SDK defaults to bundled cli.js which doesn't exist in compiled Deno binaries
            pathToClaudeCodeExecutable: process.env.ATLAS_CLAUDE_PATH,
            cwd: sandbox.workDir,
            model,
            fallbackModel,
            effort,
            tools: { type: "preset", preset: "claude_code" },
            disallowedTools: ["Bash(rm -rf:*)", "Bash(curl:*)", "Bash(wget:*)", "Bash(sudo:*)"],
            permissionMode: "bypassPermissions",
            settings: { attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false },
            settingSources: ["project"],
            maxTurns: 500,
            sandbox: sandboxOptions,
            abortController: controller,
            // Stream partial assistant messages (token-level deltas) during LLM generation.
            // Each stream_event resets the activity tracker, eliminating the blind spot where
            // the SDK is alive but silent during extended thinking.
            includePartialMessages: true,
            env: (() => {
              const env: Record<string, string | undefined> = {
                ...process.env,
                ANTHROPIC_API_KEY: apiKey,
                GH_TOKEN: ghToken,
              };
              // Strip CLAUDECODE to allow nested Claude Code execution (e.g. daemon running inside Claude Code)
              delete env.CLAUDECODE;
              return env;
            })(),
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
            // Hooks fire on tool use and subagent lifecycle — each callback updates activity
            // tracker, which resets the stall detection timer (keepalive). Hook messages also
            // appear on the stream, providing a double keepalive.
            hooks: {
              PostToolUse: [{ hooks: [keepalive] }],
              SubagentStart: [{ hooks: [keepalive] }],
              SubagentStop: [{ hooks: [keepalive] }],
            },
            // When FSM provides an output schema, use SDK's structured output to get validated JSON
            ...(outputSchema
              ? { outputFormat: { type: "json_schema" as const, schema: outputSchema } }
              : {}),
          },
        });

        const timedStream = withMessageTimeout(
          sdkStream,
          MESSAGE_TIMEOUT_MS,
          () => new Error(`SDK stalled: no activity for ${MESSAGE_TIMEOUT_MS / 1000}s`),
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
                try {
                  const progress = await generateProgress(
                    { toolName: block.name, input: block.input },
                    abortSignal,
                  );
                  stream?.emit({
                    type: "data-tool-progress",
                    data: { toolName: "Claude Code", content: progress },
                  });
                } catch (error) {
                  logger.warn("generateProgress failed, skipping progress update", {
                    error,
                    toolName: block.name,
                  });
                }
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
              // SDK puts structured data in structured_output when outputFormat is json_schema
              if ("structured_output" in message && message.structured_output != null) {
                structuredOutput = message.structured_output;
              }
              logger.debug("Execution complete", {
                cost: message.total_cost_usd,
                turns: message.num_turns,
                hasStructuredOutput: structuredOutput != null,
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
              data: {
                type: "summary" as const,
                version: 1 as const,
                data: structuredOutput != null ? JSON.stringify(structuredOutput) : responseText,
              },
              title: "Claude Code Output",
              summary: `Claude Code: ${truncateUnicode(prompt, 100, "...")}`,
            },
          }),
        );

        if (!artifactResponse.ok) {
          return err(stringifyError(artifactResponse.error));
        }

        const { id, type, summary } = artifactResponse.data.artifact;
        const extras = { artifactRefs: [{ id, type, summary }] };

        // When outputSchema is present, SDK puts validated JSON in structured_output.
        // Fall back to parsing responseText for older SDK versions or edge cases.
        if (outputSchema) {
          if (structuredOutput != null && typeof structuredOutput === "object") {
            const validated = z.record(z.string(), z.unknown()).safeParse(structuredOutput);
            if (validated.success) {
              return ok(validated.data, extras);
            }
          }
          const parsed = parseStructuredOutput(responseText);
          if (parsed) {
            return ok(parsed, extras);
          }
          logger.warn("Structured output not available, returning as text");
        }

        return ok({ response: responseText }, extras);
      } catch (error) {
        logger.error("Claude Code agent failed", { error });
        return err(stringifyError(error));
      } finally {
        sdkStream?.close(); // Terminate SDK subprocess cleanly on all exit paths
        await sandbox.cleanup();
      }
    },
  },
);
