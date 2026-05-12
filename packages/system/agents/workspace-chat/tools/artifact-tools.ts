/**
 * Artifact tools for the workspace-chat agent.
 *
 * Provides `display_artifact` (re-exported from conversation tools),
 * `get_artifact` (direct tool mirroring the MCP registration), and
 * `create_artifact` (register a scratch-dir file as a displayable artifact).
 *
 * Exported as a pre-typed `AtlasTools` object to avoid TS2589 deep type
 * instantiation when spread into `streamText`'s tools parameter.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { inferMimeFromFilename, isTextMimeType } from "@atlas/core/artifacts/file-upload";
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
 * Mirrors the MCP `get_artifact` tool (packages/mcp-server/src/tools/artifacts/get.ts)
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
const getArtifactTool = tool({
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
    logger.info("get_artifact called", { artifactId, revision });

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
  get_artifact: getArtifactTool,
  parse_artifact: parseArtifact,
};

type ArtifactToolResult =
  | { success: true; id: string; type: "file"; summary: string }
  | { success: false; error: string };

async function uploadArtifact({
  bytes,
  filename,
  title,
  summary,
  workspaceId,
  streamId,
}: {
  bytes: Uint8Array;
  filename: string;
  title: string;
  summary: string;
  workspaceId: string;
  streamId: string | undefined;
}): Promise<ArtifactToolResult> {
  // Send over the JSON wire: base64-encode bytes. The route's
  // FileDataInput parser decodes when contentEncoding === "base64".
  const base64 = encodeBase64(bytes);
  const inferredMime = inferMimeFromFilename(filename);
  const data = {
    type: "file" as const,
    content: base64,
    contentEncoding: "base64" as const,
    originalName: filename,
    ...(inferredMime && isTextMimeType(inferredMime) ? { mimeType: inferredMime } : {}),
  };

  const response = await parseResult(
    client.artifactsStorage.index.$post({
      json: { data, title, summary, workspaceId, chatId: streamId },
    }),
  );

  if (!response.ok) {
    return {
      success: false,
      error: `Failed to create artifact: ${stringifyError(response.error)}`,
    };
  }
  // Return shape matches the harvester's ArtifactOutputSchema
  // ({ id, type, summary }) at packages/agent-sdk/src/vercel-helpers/tool-usage.ts
  // so artifact refs are picked up automatically.
  return { success: true, id: response.data.artifact.id, type: "file", summary };
}

/** A filename whose extension implies binary content can't be safely
 * encoded as a UTF-8 string. Block these at the schema level so the LLM
 * can't accidentally stuff base64 into the `content` field and produce
 * a corrupted artifact. */
function isTextSafeFilename(filename: string): boolean {
  const mime = inferMimeFromFilename(filename);
  // Unknown extension → trust the caller (no MIME inferred means the
  // server-side magic-byte sniff is the only signal anyway).
  if (!mime) return true;
  return isTextMimeType(mime);
}

/**
 * Build the `create_artifact` + `save_artifact` tools scoped to the current session.
 *
 * - `save_artifact` is the preferred path when the content is already in-hand
 *   (LLM-authored text, JSON, markdown, etc.) — one call, no `write_file` round-trip.
 * - `create_artifact` registers a scratch-dir file produced by `run_code` or
 *   `write_file` — kept for binaries the LLM can't materialize inline.
 */
export function createCreateArtifactTool({
  sessionId,
  workspaceId,
  streamId,
}: {
  sessionId: string;
  workspaceId: string;
  streamId: string | undefined;
}): AtlasTools {
  return {
    save_artifact: tool({
      description:
        "Register inline UTF-8 text content as a displayable artifact in one call. Preferred over write_file → create_artifact whenever you already have the content as a string (markdown, JSON, code, prose, CSV). Binary content must go through run_code + create_artifact — filenames implying binary MIME (.png, .pdf, .zip, etc.) are rejected. Immediately call display_artifact with the returned `id`.",
      inputSchema: z.object({
        filename: z
          .string()
          .min(1)
          .describe(
            "Filename including extension (e.g. report.md, data.json). Used to infer MIME type and as the artifact's original-name. Must be text-MIME (markdown, json, csv, html, code, plain text).",
          ),
        content: z
          .string()
          .min(1)
          .describe(
            "Text content of the artifact. UTF-8 string. For binary content, write the bytes via run_code and register with create_artifact instead.",
          ),
        title: z.string().min(1).max(200).describe("Short descriptive title for the artifact."),
        summary: z
          .string()
          .min(10)
          .max(500)
          .describe("1-2 sentence description of what the artifact contains."),
      }),
      execute: async ({ filename, content, title, summary }) => {
        // Path-traversal / sandbox-escape guard. `save_artifact` doesn't
        // touch the scratch dir today, but reusing `resolveInScratch` keeps
        // filename validation aligned with the rest of the tool surface and
        // blocks `..` / absolute paths at the schema boundary.
        const resolved = resolveInScratch(sessionId, filename);
        if (!resolved.ok) return { success: false, error: resolved.error };

        if (!isTextSafeFilename(filename)) {
          return {
            success: false,
            error: `Refusing to save '${filename}' via save_artifact: filename implies binary MIME. Generate the file via run_code and register it with create_artifact.`,
          };
        }

        logger.info("save_artifact called", { sessionId, filename, workspaceId });

        return await uploadArtifact({
          bytes: new TextEncoder().encode(content),
          filename: basename(filename),
          title,
          summary,
          workspaceId,
          streamId,
        });
      },
    }),
    create_artifact: tool({
      description:
        "Register a file already written to the scratch directory (by run_code or write_file) as a displayable artifact. For inline LLM-authored text content prefer save_artifact — it skips the write_file round-trip. After registering, immediately call display_artifact with the returned `id`.",
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
          return { success: false, error: `Failed to read scratch file: ${stringifyError(err)}` };
        }

        logger.info("create_artifact called", { sessionId, path, workspaceId });

        return uploadArtifact({
          bytes,
          filename: basename(path),
          title,
          summary,
          workspaceId,
          streamId,
        });
      },
    }),
  };
}
