import type { ToolProgress } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { createAtlasClient } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

export const takeNoteTool = tool({
  name: "take_note",
  description:
    "Store a note for later. Use when you need to remember intermediate results, track clarifications, or save observations during reasoning.",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier"),
    note: z.string().describe("A note to remember"),
  }),
  execute: async ({ streamId, note }): Promise<{ stored: boolean; progress: ToolProgress }> => {
    const client = createAtlasClient();
    const response = await client.POST("/api/scratchpad/{streamId}", {
      params: { path: { streamId } },
      body: { note },
    });

    if (response.error) {
      throw new Error(`Failed to store note: ${stringifyError(response.error)}`);
    }

    const label = note.length > 60 ? `${note.slice(0, 57)}...` : note;
    return { stored: true, progress: { label, status: "completed" } };
  },
});

/**
 * Fetches scratchpad notes and formats them for system prompt injection.
 * Returns empty string if no notes exist or if an error occurs.
 *
 * @param streamId - The conversation stream identifier
 * @param logger - Logger instance for error tracking
 * @param limit - Maximum number of notes to retrieve (default: 100)
 * @returns Formatted scratchpad content or empty string
 */
export async function fetchScratchpadContext(
  streamId: string,
  logger: Logger,
  limit = 100,
): Promise<string> {
  try {
    const client = createAtlasClient();
    const response = await client.GET("/api/scratchpad/{streamId}", {
      params: { path: { streamId }, query: { limit } },
    });

    if (response.error) {
      logger.warn("Failed to fetch scratchpad for context injection", {
        error: response.error,
        streamId,
      });
      return "";
    }

    const { notes } = response.data;

    // Return empty string if no notes
    if (!notes || notes.length === 0) {
      return "";
    }

    // Format notes as numbered list with section header
    const formattedNotes = notes.map((note, index) => `${index + 1}. ${note.note}`).join("\n");

    return `# Scratchpad Notes

The following notes were taken during this conversation for context:

${formattedNotes}`;
  } catch (error) {
    // Silent degradation - log but don't block conversation
    logger.error("Exception while fetching scratchpad context", { error, streamId });
    return "";
  }
}
