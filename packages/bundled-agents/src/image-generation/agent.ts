import { type ArtifactRef, createAgent, err, ok } from "@atlas/agent-sdk";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { registry, smallLLM } from "@atlas/llm";
import { stringifyError, truncateUnicode } from "@atlas/utils";
import { generateImage } from "ai";
import { z } from "zod";
import { type DiscoveredImages, discoverImageFiles } from "./discovery.ts";

const IMAGE_SIZE: `${number}x${number}` = "1024x1024";

const MIME_TO_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg" };

/**
 * Image generation agent output schema.
 * Describes the generated/edited image and the mode used.
 */
export const ImageGenerationOutputSchema = z.object({
  description: z.string().describe("Description of the generated/edited image"),
  mode: z.enum(["generate", "edit"]).describe("Whether image was generated or edited"),
  sourceArtifactIds: z.array(z.string()).optional().describe("Source artifact IDs if edit mode"),
});

type ImageGenerationOutput = z.infer<typeof ImageGenerationOutputSchema>;

export const imageGenerationAgent = createAgent<string, ImageGenerationOutput>({
  id: "image-generation",
  displayName: "Image Generation",
  version: "1.0.0",
  description:
    "Generates new images from text descriptions and edits existing image artifacts. Reference artifacts by their UUID to edit them.",
  expertise: {
    examples: [
      "Generate an image of a sunset over mountains",
      "Create a logo for a coffee shop called 'Bean There'",
      "Draw a cartoon cat wearing a top hat",
      "Make the background blue on artifact 7f3a1b2c-...",
      "Remove the text from artifact 9e4d5c6a-...",
      "Turn artifact 3b8e2f1d-... into a watercolor painting",
    ],
  },
  outputSchema: ImageGenerationOutputSchema,

  handler: async (prompt, { session, logger, abortSignal, stream, platformModels }) => {
    let discoveredImages: DiscoveredImages;
    try {
      discoveredImages = await discoverImageFiles(prompt, abortSignal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      logger.error("Image file discovery failed", { error: stringifyError(error) });
      return err("Failed to identify image files in prompt. Please try again.");
    }

    const isEditMode = discoveredImages.artifactIds.length > 0;

    // -- Build prompt for generateImage() ------------------------------------
    // Generate mode: pass raw prompt string (preserves orchestrator context).
    // Edit mode: load source image binaries, pass as { images, text }.
    let imagePrompt: string | { images: Uint8Array[]; text: string };

    if (isEditMode) {
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Image Generation", content: "Loading source images..." },
      });

      const imageBuffers: Uint8Array[] = [];
      for (const artifactId of discoveredImages.artifactIds) {
        const binaryResult = await ArtifactStorage.readBinaryContents({ id: artifactId });
        if (!binaryResult.ok) {
          logger.warn("Failed to read source image", { artifactId, error: binaryResult.error });
          continue;
        }
        imageBuffers.push(binaryResult.data);
      }

      if (imageBuffers.length === 0) {
        return err("Could not load any source images for editing. Please try again.");
      }

      imagePrompt = { images: imageBuffers, text: prompt };
    } else {
      imagePrompt = prompt;
    }

    stream?.emit({
      type: "data-tool-progress",
      data: {
        toolName: "Image Generation",
        content: isEditMode ? "Editing image..." : "Generating image...",
      },
    });

    // -- Call model via generateImage() --------------------------------------
    // Generate: text-to-image via /images/generations
    // Edit: image-to-image via /images/edits (passes source images + text)
    // Both route through LiteLLM when LITELLM_API_KEY is set.

    const result = await generateImage({
      model: registry.imageModel("google:gemini-3.1-flash-image-preview"),
      prompt: imagePrompt,
      size: IMAGE_SIZE,
      abortSignal,
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      logger.error("Image generation failed", { error: String(error) });
      return null;
    });

    if (!result) {
      return err(
        isEditMode
          ? "Image editing failed. Try rephrasing your edit instructions."
          : "Image generation failed. Try rephrasing your prompt.",
      );
    }

    const generatedFile = result.images[0];
    if (!generatedFile) {
      return err("Model did not generate an image. Try rephrasing your prompt.");
    }

    // -- Save artifact -------------------------------------------------------

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Image Generation", content: "Saving image..." },
    });

    const mediaType = generatedFile.mediaType;
    const ext = MIME_TO_EXT[mediaType] ?? ".png";
    const imageId = crypto.randomUUID();
    const fallbackTitle = `${isEditMode ? "Edited Image" : "Generated Image"}: ${imageId}`;
    const titlePrefix = isEditMode ? "Edited Image" : "Generated Image";

    const title = await smallLLM({
      platformModels,
      system: `You generate concise image titles. Return ONLY the title, no quotes, no explanation. Max 80 characters. Describe what the image depicts, not the prompt itself. Ignore any context facts or metadata in the prompt — focus on the actual user request.`,
      prompt: `Generate a short title for an image ${isEditMode ? "edited" : "generated"} from this prompt:\n${prompt}`,
      abortSignal,
      maxOutputTokens: 60,
    })
      .then((text) => {
        const trimmed = text.trim();
        return trimmed.length >= 3
          ? `${titlePrefix}: ${truncateUnicode(trimmed, 80)}`
          : fallbackTitle;
      })
      .catch(() => fallbackTitle);

    const summary = truncateUnicode(prompt, 200);
    const originalName = `${isEditMode ? "edited" : "generated"}-image${ext}`;

    // Copy into an ArrayBuffer-backed Uint8Array so the schema's
    // `Uint8Array<ArrayBuffer>` typing is satisfied (the AI SDK returns
    // `Uint8Array<ArrayBufferLike>`).
    const imageBytes = new Uint8Array(generatedFile.uint8Array.byteLength);
    imageBytes.set(generatedFile.uint8Array);

    const artifactResult = await ArtifactStorage.create({
      workspaceId: session.workspaceId,
      chatId: session.streamId,
      data: { type: "file", content: imageBytes, mimeType: mediaType, originalName },
      title,
      summary,
    });

    if (!artifactResult.ok) {
      logger.error("Failed to create image artifact", { error: artifactResult.error });
      return err(
        `Failed to save ${isEditMode ? "edited" : "generated"} image: ${artifactResult.error}`,
      );
    }

    const artifactRefs: ArtifactRef[] = [
      {
        id: artifactResult.data.id,
        type: artifactResult.data.type,
        summary: artifactResult.data.summary,
      },
    ];

    const mode = isEditMode ? "edit" : "generate";
    logger.info("Image generation complete", { mode, imageSize: IMAGE_SIZE, mediaType });

    return ok(
      {
        description: prompt,
        mode: mode as "generate" | "edit",
        sourceArtifactIds: isEditMode ? discoveredImages.artifactIds : undefined,
      },
      { artifactRefs },
    );
  },
});
