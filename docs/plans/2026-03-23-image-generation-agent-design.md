<!-- v2 - 2026-03-23 - Generated via /improving-plans from docs/plans/2026-03-23-image-generation-agent-design.md -->

# Image Generation Agent — Design Document

**Date**: 2026-03-23
**Status**: Planning

---

## Problem Statement

Users want to generate and edit images within Friday conversations. Today there's
no way to create images — users must use external tools (Midjourney, DALL-E,
Canva) and manually upload results. This breaks the conversational flow and
prevents Friday from being a complete creative assistant.

## Solution

Add a bundled `image-generation` agent that uses Google's Gemini 3.1 Flash Image
Preview model ("Nano Banana 2") to generate and edit images. The agent operates
in two modes based on input:

- **Generate mode**: No image artifact referenced in prompt → generate a new
  image from text, return as a new file artifact
- **Edit mode**: Image artifact UUID(s) detected in prompt → load those images,
  pass them alongside the user's instruction to the model, return a new file
  artifact

The model is a language model with native image output — no separate image API
or new dependencies required. Uses the existing Google provider in the LLM
registry.

---

## User Stories

1. As a user, I want to ask Friday to generate an image from a text description,
   so that I can create visual content without leaving the conversation.
2. As a user, I want to reference an existing image artifact and ask for edits
   (e.g., "make the background blue"), so that I can iterate on images
   conversationally.
3. As a user, I want generated images saved as artifacts in my library, so that
   I can reference them later in other conversations or agents.
4. As a user, I want to control image resolution via workspace config, so that
   I can balance cost vs quality for my use case.
5. As a workspace admin, I want to configure the image generation agent's
   resolution default, so that I can control costs across the workspace.
6. As a user, I want clear error messages when image generation fails (content
   policy, invalid input), so that I understand what went wrong and can retry.
7. As a user, I want to generate images for use in other workflows (e.g., Slack
   posts, email drafts), so that Friday can produce complete multimedia outputs.
8. As a planner agent, I want to delegate image generation tasks to a specialized
   agent, so that visual content can be part of multi-step workflows.
9. As a user, I want to reference multiple image artifacts for style transfer or
   composition (e.g., "combine these two images"), so that I can do more complex
   edits.

---

## Implementation Decisions

### Model Selection

**Model:** `gemini-3.1-flash-image-preview` (Nano Banana 2), hardcoded.

This is a language model with native image generation — not a standalone image
API. It supports text+image input and text+image output through the standard
`generateText()` call with `responseModalities: ['TEXT', 'IMAGE']` in provider
options.

**Why this model:**
- Zero new dependencies (Google provider already wired in registry)
- Conversational editing support (can understand "make the hat red" with context)
- Good quality at reasonable cost (~$0.067/image at 1K)
- 4K output support
- Latest Nano Banana variant (Feb 2026)
- Supports up to 14 image references (10 object + 4 character) for editing

**Cost reference:**

| Resolution | ~$/image |
|------------|----------|
| 512        | $0.045   |
| 1K         | $0.067   |
| 2K         | $0.101   |
| 4K         | $0.151   |

### Output Format

- **Format:** PNG (Nano Banana always returns `image/png`)
- **Aspect ratio:** 1:1 (hardcoded for v1)
- **Default resolution:** 1K
- **Configurable resolution:** Via `config.resolution` in workspace.yml
  (`"512"`, `"1K"`, `"2K"`, `"4K"`) — these are the SDK's native values

### Two Operating Modes

**Mode detection:** Extract artifact UUIDs from the prompt using the same UUID
regex pattern as the transcription agent. Validate each against artifact storage,
filter to image MIME types (`image/png`, `image/jpeg`, `image/webp`, `image/gif`)
via `isImageMimeType()`.

- **UUIDs found + at least one is an image artifact** → Edit mode
- **No image artifacts found** → Generate mode

**Generate mode flow:**
1. Emit progress: `"Generating image..."`
3. Call `generateText()` with user's prompt + image generation provider options
4. Extract image from `result.files`
5. Write PNG to workspace files directory
6. Create file artifact via `ArtifactStorage.create()`
7. Return `ok(output, { artifactRefs })`

**Edit mode flow:**
1. Emit progress: `"Loading source image(s)..."`
3. Read binary contents of ALL referenced image artifacts via
   `ArtifactStorage.readBinaryContents()` — multiple images are passed as
   multiple `ImagePart`s, letting the model handle composition, style transfer,
   or comparison use cases (Nano Banana supports up to 14 references)
4. Emit progress: `"Editing image..."`
5. Call `generateText()` with user's text instruction + source images as
   `ImagePart`s + image generation provider options
6. Extract edited image from `result.files`
7. Write PNG to workspace files directory
8. Create new file artifact via `ArtifactStorage.create()`
9. Return `ok(output, { artifactRefs })`

**Stateless design:** Each handler invocation is independent. The agent does not
maintain conversation history across calls — edit mode loads the referenced
image(s) fresh each time.

<!-- Future improvement: Multi-turn editing could be supported by persisting the
Gemini message history (all prior prompts + generated images) across invocations.
This would enable true conversational editing chains ("make it redder", "now add
a border") where the model retains full context. Would require a dedicated
message history store since each image is 1-4MB base64 — storing in artifact
metadata would bloat too fast. Not needed for v1 since the artifact-reference
pattern covers the primary edit use case. -->

### Artifact Storage

Generated images are stored as file artifacts following the transcription agent
pattern:

1. Write PNG binary to workspace files directory via
   `getWorkspaceFilesDir(session.workspaceId)`
2. Filename format: `image-{crypto.randomUUID()}.png`
3. Create artifact with `type: "file"`, `version: 1`,
   `data: { path, originalName: "generated-image.png" }`
4. Title format: `"Generated Image: {truncated prompt}"` (generate mode) or
   `"Edited Image: {truncated instruction}"` (edit mode)
5. Summary: First 200 characters of the user's prompt/instruction

Each generation/edit creates a **new artifact** — edits do not update the source
artifact's revision.

### Agent Definition

```
packages/bundled-agents/src/image-generation/
├── agent.ts          # createAgent() definition with handler
└── index.ts          # Exports
```

**Agent metadata:**
- **ID:** `image-generation`
- **Display name:** Image Generation
- **Version:** `1.0.0`
- **Description:** Generates and edits images from text descriptions using
  Google's Gemini image model
- **Expertise examples:**
  - "Generate an image of a sunset over mountains"
  - "Create a logo for a coffee shop called 'Bean There'"
  - "Edit this image to make the sky more dramatic"

**Environment variables:** None agent-specific. The Google provider resolves
`GEMINI_API_KEY` (or routes through LiteLLM when `LITELLM_API_KEY` is set)
via the registry — no agent-level credential guard needed. This matches the
pattern used by data-analyst and web-search agents that also go through the
registry.

**No MCP servers, no additional tools.** The agent calls `generateText()`
directly — the model IS the image generator.

### Output Schema

```typescript
z.object({
  description: z.string().describe("Description of the generated/edited image"),
  mode: z.enum(["generate", "edit"]).describe("Whether image was generated or edited"),
  sourceArtifactIds: z.array(z.string()).optional().describe("Source artifact IDs if edit mode"),
})
```

### Workspace Configuration

```yaml
agents:
  image-gen:
    type: "atlas"
    agent: "image-generation"
    description: "Generates and edits images from text prompts"
    config:
      resolution: "1K"  # "512" | "1K" | "2K" | "4K"
```

### Error Handling

- **No image in response:** Model may return text-only if prompt is ambiguous →
  return `err("Model did not generate an image. Try rephrasing your prompt.")`
- **Content policy rejection:** Gemini may refuse certain prompts →
  return `err("Image generation was blocked by content policy.")`
- **Artifact not found:** Referenced UUID doesn't exist or isn't an image →
  return `err("Could not find image artifact {id}.")`
- **Binary read failure:** Can't read source image for editing →
  return `err("Failed to read source image.")`
- **AbortError:** Re-thrown for cancellation support

### Provider Options

```typescript
providerOptions: {
  google: {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: {
      imageSize: config?.resolution ?? '1K',
      aspectRatio: '1:1',
    },
  },
}
```

---

## Testing Decisions

### What Makes a Good Test

Tests should exercise the agent's two modes (generate/edit) and error paths.
Mock `generateText()` from the AI SDK and `ArtifactStorage` — these are the
external boundaries. Test the mode detection logic (UUID extraction + image
MIME filtering) with real data.

### Modules to Test

- **`agent.ts`** — Handler flow for both modes, artifact creation, error
  handling, progress emission, config resolution parsing, multi-image edit mode

### Prior Art

- `packages/bundled-agents/src/transcription/agent.ts` — same artifact
  discovery pattern (UUID regex), same artifact creation flow, same error
  handling style

---

## Out of Scope

- **Multi-turn conversation history** — each call is stateless; see future
  improvement comment in implementation section
- **Multiple image generation** — one output image per invocation for v1
- **Image upscaling/super-resolution** — separate concern
- **Video generation** — future phase, different model (Veo 3.1)
- **Provider flexibility** — hardcoded to Gemini; adding OpenAI/FLUX support
  would require the `experimental_generateImage` tool pattern
- **Image format selection** — always PNG for v1
- **Batch generation** — no batch API usage for v1
- **Custom aspect ratios** — hardcoded 1:1 for v1
- **Inpainting/masking** — advanced editing, not supported by Nano Banana's
  conversational API

---

## Further Notes

### Nano Banana 2 Specifics

- Model ID: `gemini-3.1-flash-image-preview`
- Uses standard `generateText()` / `streamText()` — not a separate image API
- Images returned in `result.files` with `mediaType` and `uint8Array`
- Always returns `image/png` format (confirmed via API docs and community)
- Known Google bug: rarely returns JPEG bytes with PNG mime type (mainly on Pro
  model, not Flash) — not worth handling for v1
- Supports Google Search grounding for real-time data in image generation
- Up to 10 object references + 4 character references per request
- SynthID watermarking applied automatically
- English-optimized prompts (multilingual text rendering supported)
- Supported aspect ratios: 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4,
  8:1, 9:16, 16:9, 21:9

### AI SDK Integration Details

- `@ai-sdk/google@^2.0.62` supports `responseModalities` and `imageConfig` in
  provider options (confirmed in SDK types)
- `result.files` returns `Array<GeneratedFile>` with `base64`, `uint8Array`,
  and `mediaType` properties
- `imageConfig.imageSize` accepts `"512" | "1K" | "2K" | "4K"` (not `"0.5K"`)
- When using `generateText()` path, `mediaType` comes from Gemini's declared
  `inlineData.mimeType` (always `"image/png"`)

### Cost Considerations

Token-based pricing (not per-image):
- Input: $0.50/1M tokens
- Output: $60/1M tokens
- Batch API: 50% discount (up to 24h turnaround)

At 1K resolution, typical generation costs ~$0.067. Cheaper alternatives exist
(Imagen 4 Fast at $0.02, GPT Image 1-mini at $0.005) but require different API
patterns and lose conversational editing capability.

### Relationship to Existing Image Support

Atlas already supports image upload and image input to agents (via
`resolveImageParts()` in `packages/core/src/artifacts/images.ts`). This agent
adds the missing image OUTPUT capability. The artifact system already handles
image MIME types — no storage changes needed.
