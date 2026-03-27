import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import { type ArtifactRef, createAgent, err, ok } from "@atlas/agent-sdk";
import { type Artifact, ArtifactStorage } from "@atlas/core/artifacts/server";
import { registry } from "@atlas/llm";
import { stringifyError, truncateUnicode } from "@atlas/utils";
import { getWorkspaceFilesDir } from "@atlas/utils/paths.server";
import { experimental_transcribe } from "ai";
import { z } from "zod";

import { discoverAudioFiles } from "./discovery.ts";

/**
 * Transcription agent output schema.
 * Each entry in `transcripts` corresponds to one audio file — successful transcriptions
 * include the text; failures include an error message.
 *
 * Note: Whisper can hallucinate short phrases (e.g. "Thank you.") from silent audio
 * rather than throwing AI_NoTranscriptGeneratedError. This is a known upstream behavior,
 * not a bug in our error classification.
 */
export const TranscriptionOutputSchema = z.object({
  transcripts: z.array(
    z.object({
      status: z.enum(["ok", "error"]),
      fileName: z.string(),
      transcript: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

type TranscriptionResult = z.infer<typeof TranscriptionOutputSchema>;

/** Classifies transcription errors into user-friendly messages. */
function classifyTranscriptionError(error: unknown): string {
  if (error instanceof Error && error.name === "AI_NoTranscriptGeneratedError") {
    return "No speech detected in audio file";
  }

  if (error instanceof APICallError) {
    if (error.statusCode === 429) {
      return "Transcription service is busy, try again shortly";
    }
    if (error.statusCode !== undefined && error.statusCode >= 500) {
      return "Transcription service unavailable";
    }
  }

  return stringifyError(error);
}

export const transcriptionAgent = createAgent<string, TranscriptionResult>({
  id: "transcribe",
  displayName: "Transcription",
  version: "1.0.0",
  summary: "Transcribe audio files (voice memos, recordings, podcasts) to text using Whisper.",
  description: "Transcribes audio files (voice memos, recordings, podcasts) to text using Whisper",
  useWorkspaceSkills: true,
  expertise: {
    examples: [
      "Transcribe this audio file",
      "Convert this recording to text",
      "What does this voice memo say?",
      "Transcribe this and summarize it",
    ],
  },
  outputSchema: TranscriptionOutputSchema,

  handler: async (prompt, { session, logger, abortSignal, stream }) => {
    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Transcription", content: "Reading audio file..." },
    });

    let artifactIds: string[];
    let artifacts: Map<string, Artifact>;
    try {
      ({ artifactIds, artifacts } = await discoverAudioFiles(prompt, abortSignal));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      logger.error("Audio file discovery failed", { error: stringifyError(error) });
      return err("Failed to identify audio files in prompt. Please try again.");
    }

    if (artifactIds.length === 0) {
      return err(
        "No audio file artifacts found in prompt. Please attach an audio file to transcribe.",
      );
    }

    const transcripts: TranscriptionResult["transcripts"] = [];
    const artifactRefs: ArtifactRef[] = [];
    const isMultiple = artifactIds.length > 1;

    for (const id of artifactIds) {
      const artifact = artifacts.get(id);
      let fileName = "audio";
      if (artifact?.data.type === "file" && artifact.data.data.originalName) {
        fileName = artifact.data.data.originalName;
      }

      const readResult = await ArtifactStorage.readBinaryContents({ id });

      if (!readResult.ok) {
        logger.warn("Failed to read audio artifact", { id, error: readResult.error });
        transcripts.push({
          status: "error",
          fileName,
          error: `Failed to read audio file: ${readResult.error}`,
        });
        continue;
      }

      const progressLabel = isMultiple ? `Transcribing ${fileName}...` : "Transcribing audio...";
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Transcription", content: progressLabel },
      });

      try {
        const result = await experimental_transcribe({
          model: registry.transcriptionModel("groq:whisper-large-v3-turbo"),
          audio: readResult.data,
          abortSignal,
        });

        stream?.emit({
          type: "data-tool-progress",
          data: { toolName: "Transcription", content: "Saving transcript..." },
        });

        const workspaceFilesDir = getWorkspaceFilesDir(session.workspaceId);
        await mkdir(workspaceFilesDir, { recursive: true });

        const diskFileName = `transcript-${crypto.randomUUID()}.txt`;
        const displayName = `transcript-${fileName.replace(/\.[^.]+$/, "")}.txt`;
        const filePath = join(workspaceFilesDir, diskFileName);
        await writeFile(filePath, result.text, "utf-8");

        const artifactResult = await ArtifactStorage.create({
          workspaceId: session.workspaceId,
          chatId: session.streamId,
          data: { type: "file", version: 1, data: { path: filePath, originalName: displayName } },
          title: `Transcript: ${fileName}`,
          summary: truncateUnicode(result.text, 200),
        });

        if (!artifactResult.ok) {
          await unlink(filePath).catch(() => {});
          logger.error("Failed to create transcript artifact", { error: artifactResult.error });
          transcripts.push({
            status: "error",
            fileName,
            error: `Failed to save transcript: ${artifactResult.error}`,
          });
          continue;
        }

        artifactRefs.push({
          id: artifactResult.data.id,
          type: artifactResult.data.type,
          summary: artifactResult.data.summary,
        });

        transcripts.push({ status: "ok", fileName, transcript: result.text });

        logger.info("Transcription complete", { fileName, transcriptLength: result.text.length });
      } catch (error) {
        // AbortError must propagate for cancellation to work
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }

        const message = classifyTranscriptionError(error);
        logger.warn("Transcription failed for file", { fileName, error: message });
        transcripts.push({ status: "error", fileName, error: message });
      }
    }

    const successCount = transcripts.filter((t) => t.status === "ok").length;

    if (successCount === 0) {
      const errors = transcripts.map((t) => `${t.fileName}: ${t.error ?? "unknown"}`).join("; ");
      return err(`All transcriptions failed: ${errors}`);
    }

    return ok({ transcripts }, { artifactRefs });
  },
});
