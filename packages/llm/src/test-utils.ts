/**
 * Test-only helpers for `@atlas/llm` consumers. Not intended for production
 * code paths — exported so every package's test suite can share a single
 * `PlatformModels` stub instead of reinventing it.
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { PlatformModels, PlatformRole } from "./platform-models.ts";

/**
 * Build a structurally-valid `LanguageModelV3` whose `doGenerate`/`doStream`
 * throw if invoked. Tests that need real behavior should pass an override via
 * `createStubPlatformModels`.
 */
function createStubLanguageModel(role: PlatformRole): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "stub.language-model",
    modelId: role,
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error(`stub LanguageModelV3 for role '${role}' invoked`)),
    doStream: () => Promise.reject(new Error(`stub LanguageModelV3 for role '${role}' invoked`)),
  };
}

/**
 * Construct a `PlatformModels` stub that returns a minimal but valid
 * `LanguageModelV3` for every role. Pass `overrides` to supply a real or
 * pre-mocked model for a specific role — useful for tests that need to
 * exercise `doStream`/`doGenerate`.
 *
 * @example
 * ```ts
 * const platformModels = createStubPlatformModels();
 * // …or with a per-role override:
 * const platformModels = createStubPlatformModels({ planner: myMockModel });
 * ```
 */
export function createStubPlatformModels(
  overrides?: Partial<Record<PlatformRole, LanguageModelV3>>,
): PlatformModels {
  return {
    get(role: PlatformRole): LanguageModelV3 {
      if (overrides?.[role]) {
        return overrides[role];
      }
      return createStubLanguageModel(role);
    },
  };
}
