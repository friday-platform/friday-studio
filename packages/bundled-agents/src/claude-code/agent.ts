import { type ArtifactRef, createAgent } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { ANTHROPIC_CACHE_BREAKPOINT, anthropic } from "@atlas/core";
import type { Logger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { generateText, stepCountIs, streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

type CCAgentResult = Result<
  // Summary of the research findings
  { response: string; artifactRef: ArtifactRef },
  // Reason for failure
  { reason: string }
>;

/**
 * Format tool invocation as concise single-line status message (≤50 chars).
 * Used to stream progress updates during code execution.
 */
async function generateProgress(
  context: unknown,
  abortSignal?: AbortSignal,
  logger?: Logger,
): Promise<string> {
  const contextStr = typeof context === "string" ? context : JSON.stringify(context, null, 2);

  const result = await generateText({
    model: anthropic("claude-haiku-4-5"),
    abortSignal,
    messages: [
      {
        role: "system",
        content: `Format tool invocation as single-line status. Output only the status line, no explanations.

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
        providerOptions: ANTHROPIC_CACHE_BREAKPOINT,
      },
      { role: "user", content: contextStr },
    ],
    temperature: 0.4,
    maxOutputTokens: 50,
  });

  logger?.info("AI SDK generateText completed", {
    agent: "claude-code",
    step: "generate-progress",
    usage: result.usage,
  });

  return result.text;
}

export const claudeCodeAgent = createAgent<string, CCAgentResult>({
  id: "claude-code",
  displayName: "Claude Code",
  version: "1.0.0",
  description: "Execute tasks using Claude Code with local filesystem access and tool integration",
  expertise: {
    domains: ["code-generation", "file-operations", "development"],
    examples: [
      "Write a TypeScript function to parse JSON",
      "Read and analyze the package.json file",
    ],
  },
  handler: async (prompt, { logger, abortSignal, stream }) => {
    /**
     * Execute prompt via Claude Code provider.
     * Streams progress as tools execute, stores result as artifact, returns summary.
     */
    try {
      logger.debug("Starting Claude Code agent execution", { prompt });

      const result = streamText({
        model: claudeCode("sonnet", {
          disallowedTools: ["Bash(rm:*)"],
          maxTurns: 25,
          permissionMode: "bypassPermissions",
          settingSources: ["user", "project", "local"],
          streamingInput: "always",
          systemPrompt: { type: "preset", preset: "claude_code" },
        }),
        messages: [
          {
            role: "system",
            content: `Return summary of actions taken. Output only the summary—no preamble or explanation.
          DO NOT explain what you are going to do. Just do it.

          Your summary:
            - Direct, factual
            - Concise. Sacrifice grammar for concision, but keep clarity
            - Use markdown`,
            providerOptions: ANTHROPIC_CACHE_BREAKPOINT,
          },
          { role: "user", content: prompt },
        ],
        abortSignal,
        stopWhen: stepCountIs(25),
        maxOutputTokens: 30000,
        onChunk: async ({ chunk }) => {
          switch (chunk.type) {
            case "tool-call": {
              const message = await generateProgress(
                { toolName: chunk.toolName, input: chunk.input },
                abortSignal,
                logger,
              );
              stream?.emit({
                type: "data-tool-progress",
                data: { toolName: "Claude Code", content: message },
              });
            }
          }
        },
      });

      const responseText = await result.text;
      const usage = await result.usage;

      logger.debug("AI SDK streamText completed", {
        agent: "claude-code",
        step: "main-execution",
        usage,
      });

      logger.debug("Claude Code execution completed", { responseLength: responseText.length });

      const artifactResponse = await parseResult(
        client.artifactsStorage.index.$post({
          json: {
            data: { type: "summary" as const, version: 1 as const, data: responseText },
            summary: `Claude Code: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
          },
        }),
      );

      if (!artifactResponse.ok) {
        logger.error("Artifact creation failed", { error: artifactResponse.error });
        return fail({ reason: stringifyError(artifactResponse.error) });
      }
      return success({ response: responseText, artifactRef: artifactResponse.data.artifact });
    } catch (error) {
      logger.error("Claude Code agent failed", { error });
      return fail({ reason: `Agent failed to execute: ${stringifyError(error)}` });
    }
  },
});
