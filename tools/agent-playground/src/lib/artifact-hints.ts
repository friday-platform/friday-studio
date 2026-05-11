/**
 * Quick-and-dirty map of bundled agents that consume artifacts as input.
 *
 * The agent schema doesn't (yet) declare artifact dependencies, so we
 * hardcode them here so the playground can show an upload zone when relevant.
 *
 * TODO: replace with a declarative `artifacts` field on `createAgent` config
 * once we're ready to make it systemic.
 */

export interface ArtifactInputHint {
  /** File extensions the upload zone should accept. */
  accept: string[];
  /** Whether the agent requires at least one file to function. */
  required: boolean;
  /** Short label for the upload zone. */
  label: string;
  /**
   * How the file content reaches the agent:
   * - "artifact-ref": upload to daemon → create artifact → inject artifact ID via Signal Data
   * - "inline-content": read file as text client-side → inject content directly into prompt
   */
  mode: "artifact-ref" | "inline-content";
}

/**
 * Agents that need file input to function.
 * Keyed by agent id from the bundled-agents registry.
 */
const ARTIFACT_INPUT_HINTS: Record<string, ArtifactInputHint> = {
  "get-summary": {
    accept: [".txt", ".md", ".csv", ".json"],
    required: false,
    label: "Content to summarize",
    mode: "inline-content",
  },
  transcribe: {
    accept: [".mp3", ".wav", ".m4a", ".ogg", ".webm", ".mp4"],
    required: true,
    label: "Audio or video file to transcribe",
    mode: "artifact-ref",
  },
};

/**
 * Returns the artifact hint for an agent, or undefined if it doesn't need file input.
 */
export function getArtifactHint(agentId: string): ArtifactInputHint | undefined {
  return ARTIFACT_INPUT_HINTS[agentId];
}
