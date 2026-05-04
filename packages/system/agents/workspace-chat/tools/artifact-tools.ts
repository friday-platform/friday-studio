/**
 * Artifact tools for the workspace-chat agent.
 *
 * Provides `display_artifact` (re-exported from conversation tools),
 * `artifacts_get` (direct tool mirroring the MCP registration), and
 * `artifacts_create` (register a scratch-dir file as a displayable artifact).
 *
 * Exported as a pre-typed `AtlasTools` object to avoid TS2589 deep type
 * instantiation when spread into `streamText`'s tools parameter.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { createLogger } from "@atlas/logger";
import { encodeBase64 } from "@std/encoding/base64";
import { tool } from "ai";
import { z } from "zod";
import { displayArtifact } from "./display-artifact.ts";
import { resolveInScratch } from "./file-io.ts";

const logger = createLogger({ name: "workspace-chat-artifacts" });

/**
 * Direct tool for retrieving an artifact by ID.
 * Mirrors the MCP `artifacts_get` tool (packages/mcp-server/src/tools/artifacts/get.ts)
 * so workspace-chat can use it without platform tool passthrough.
 */
const artifactsGet = tool({
  description: "Get artifact by ID",
  inputSchema: z.object({
    artifactId: z.string().describe("Artifact ID"),
    revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Revision number (defaults to latest)"),
  }),
  execute: async ({ artifactId, revision }) => {
    logger.info("artifacts_get called", { artifactId, revision });

    const response = await parseResult(
      client.artifactsStorage[":id"].$get({
        param: { id: artifactId },
        query: { revision: revision?.toString() },
      }),
    );

    if (!response.ok) {
      return { success: false, error: `Failed to retrieve artifact: ${artifactId}` };
    }

    const { artifact, contents } = response.data;
    return { ...artifact, contents };
  },
});

/** Artifact tools typed as AtlasTools to prevent TS2589 in streamText generics. */
export const artifactTools: AtlasTools = {
  display_artifact: displayArtifact,
  artifacts_get: artifactsGet,
};

/**
 * Build the `artifacts_create` tool scoped to the current session.
 * Takes a scratch-relative path, registers it as a file artifact, and
 * returns the artifact ID so the caller can immediately `display_artifact`.
 */
export function createArtifactsCreateTool({
  sessionId,
  workspaceId,
  streamId,
}: {
  sessionId: string;
  workspaceId: string;
  streamId: string | undefined;
}): AtlasTools {
  return {
    artifacts_create: tool({
      description:
        "Register a file written to the scratch directory as a displayable artifact. Call this after write_file or run_code has produced a file you want to show the user, then immediately call display_artifact with the returned artifactId.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe(
            "Relative path to the file inside the session scratch dir — same format as write_file/read_file.",
          ),
        title: z.string().min(1).max(200).describe("Short descriptive title for the artifact."),
        summary: z
          .string()
          .min(10)
          .max(500)
          .describe("1-2 sentence description of what the artifact contains."),
      }),
      execute: async ({ path, title, summary }) => {
        const resolved = resolveInScratch(sessionId, path);
        if (!resolved.ok) return { success: false, error: resolved.error };

        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await readFile(resolved.absolute));
        } catch (err) {
          return { success: false, error: `Failed to read scratch file: ${String(err)}` };
        }

        // Send over the JSON wire: base64-encode bytes. The route's
        // FileDataInput parser decodes when contentEncoding === "base64".
        const base64 = encodeBase64(bytes);

        const data = {
          type: "file" as const,
          content: base64,
          contentEncoding: "base64" as const,
          originalName: basename(path),
        };

        logger.info("artifacts_create called", { sessionId, path, workspaceId });

        const response = await parseResult(
          client.artifactsStorage.index.$post({
            json: { data, title, summary, workspaceId, chatId: streamId },
          }),
        );

        if (!response.ok) {
          return { success: false, error: `Failed to create artifact: ${String(response.error)}` };
        }

        return { success: true, artifactId: response.data.artifact.id };
      },
    }),
  };
}
