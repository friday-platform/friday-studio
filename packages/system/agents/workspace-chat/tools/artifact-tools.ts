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
import { inferMimeFromFilename } from "@atlas/core/artifacts/file-upload";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
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
 *
 * For text-like artifacts (json/yaml/text/*) the response includes the
 * decoded contents inline. For binary artifacts (PDF/image/etc.) the
 * server returns metadata + a `hint` directing you to the right
 * follow-up tool — `parse_artifact` to extract text from PDF/DOCX/PPTX,
 * `display_artifact` to surface visually. This avoids round-tripping
 * decoded-as-UTF-8 bytes through the LLM, which is both expensive and
 * useless (the model can't reason about random bytes).
 */
const artifactsGet = tool({
  description:
    "Get artifact by ID. For binary artifacts (PDF/image/etc.), use the returned `hint` to choose the right follow-up tool; the response will not include raw bytes.",
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

    const { artifact, contents, hint } = response.data;
    return { ...artifact, contents, hint };
  },
});

/**
 * Direct tool for extracting text from a binary artifact (PDF/DOCX/PPTX).
 * Runs the bytes through the same converters used at upload time and
 * returns markdown. Use this instead of fetching artifact bytes and
 * piping them through `run_code` — that pattern costs thousands of
 * prompt tokens per page and frequently fails on multi-page documents.
 */
const parseArtifact = tool({
  description:
    "Extract text from a binary artifact (PDF, DOCX, or PPTX) as markdown. Use whenever you need the *contents* of a binary artifact for reasoning. Returns `{ markdown, mimeType, filename }`.",
  inputSchema: z.object({ artifactId: z.string().describe("Artifact ID of a PDF/DOCX/PPTX file") }),
  execute: async ({ artifactId }) => {
    logger.info("parse_artifact called", { artifactId });

    const response = await parseResult(
      client.artifactsStorage[":id"].parse.$get({ param: { id: artifactId } }),
    );

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to parse artifact: ${stringifyError(response.error)}`,
      };
    }
    return response.data;
  },
});

/** Artifact tools typed as AtlasTools to prevent TS2589 in streamText generics. */
export const artifactTools: AtlasTools = {
  display_artifact: displayArtifact,
  artifacts_get: artifactsGet,
  parse_artifact: parseArtifact,
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

        const filename = basename(path);
        const inferredMime = inferMimeFromFilename(filename);
        const data = {
          type: "file" as const,
          content: base64,
          contentEncoding: "base64" as const,
          originalName: filename,
          ...(inferredMime ? { mimeType: inferredMime } : {}),
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
