import process from "node:process";
import { buildRegistryModelId, isRegistryProvider, type RegistryModelId } from "@atlas/llm";

/**
 * Resolve a `provider:model` string into a `RegistryModelId`, falling back
 * to a per-eval default when the env var is unset.
 *
 * Used by the workspace-chat evals so a developer can compare candidate models
 * (`WORKSPACE_CHAT_EVAL_MODEL=anthropic:claude-haiku-4-5 deno task evals ...`)
 * without editing each eval file. Hoisted out of the eval files so the
 * provider validation stays consistent.
 *
 * @param envVar    Name of the env var to read (kept caller-specific so the
 *                  error message points at the right knob).
 * @param fallback  Returned when the env var is unset.
 */
export function resolveModelId(envVar: string, fallback: RegistryModelId): RegistryModelId {
  const raw = process.env[envVar];
  if (!raw) return fallback;

  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(`${envVar} must be in "provider:model" form, got "${raw}".`);
  }

  const provider = raw.slice(0, colonIdx);
  const model = raw.slice(colonIdx + 1);
  if (!isRegistryProvider(provider)) {
    throw new Error(
      `${envVar} has unknown provider "${provider}". ` +
        `Expected one of: anthropic, claude-code, google, groq, openai.`,
    );
  }
  return buildRegistryModelId(provider, model);
}
