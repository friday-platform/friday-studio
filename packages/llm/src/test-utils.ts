/**
 * Test-only helpers for `@atlas/llm` consumers. Not intended for production
 * code paths — exported so every package's test suite can share a single
 * `PlatformModels` stub instead of reinventing it.
 */

import type { ImageModelV3, LanguageModelV3 } from "@ai-sdk/provider";
import type { PlatformModels, PlatformRole } from "./platform-models.ts";

type LanguageRole = Exclude<PlatformRole, "image">;

/**
 * Build a structurally-valid `LanguageModelV3` whose `doGenerate`/`doStream`
 * throw if invoked. Tests that need real behavior should pass an override via
 * `createStubPlatformModels`.
 */
function createStubLanguageModel(role: LanguageRole): LanguageModelV3 {
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
 * Build a structurally-valid `ImageModelV3` whose `doGenerate` throws if
 * invoked. Tests that need real behavior should pass an override via
 * `createStubPlatformModels`.
 */
function createStubImageModel(): ImageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "stub.image-model",
    modelId: "stub-image",
    maxImagesPerCall: 1,
    doGenerate: () => Promise.reject(new Error("stub ImageModelV3 invoked")),
  };
}

/**
 * Construct a `PlatformModels` stub that returns minimal but valid models for
 * every role. Pass `overrides` to supply a real or pre-mocked model — useful
 * for tests that need to exercise `doStream`/`doGenerate`.
 *
 * `imageOverlayKey` defaults to the canonical overlay default
 * (`google:gemini-2.5-flash-image`) so agents that look up capability metadata
 * via the resolved `key` resolve a real overlay entry. Override per-test to
 * exercise other entries (e.g. `"openai:dall-e-3"` for size-axis dispatch).
 *
 * `get` / `getImageResolved` accept wholesale function overrides for tests
 * that want to (a) spy on calls via a `vi.fn()` they retain a reference to,
 * or (b) hard-fail on unexpected invocation (regression guard for tests that
 * mock the LLM dependency further upstream and want to prove `platformModels`
 * is never read). When supplied, these take precedence over the per-role
 * model overrides — pick one strategy or the other, not both.
 *
 * @example
 * ```ts
 * const platformModels = createStubPlatformModels();
 * // …or with a per-role override:
 * const platformModels = createStubPlatformModels({ planner: myMockModel });
 * // …or override the image model:
 * const platformModels = createStubPlatformModels({ image: myMockImageModel });
 * // …or pin the overlay key for capability lookups:
 * const platformModels = createStubPlatformModels({ imageOverlayKey: "openai:dall-e-3" });
 * // …or pass a spy / throwing override for regression-guard assertions:
 * const platformModels = createStubPlatformModels({
 *   get: () => { throw new Error("get should not be called when smallLLM is mocked") },
 * });
 * ```
 */
export function createStubPlatformModels(
  overrides?: Partial<Record<LanguageRole, LanguageModelV3>> & {
    image?: ImageModelV3;
    imageOverlayKey?: string;
    /** Wholesale override of `get`. Takes precedence over per-role overrides. */
    get?: PlatformModels["get"];
    /** Wholesale override of `getImageResolved`. Takes precedence over `image`/`imageOverlayKey`. */
    getImageResolved?: PlatformModels["getImageResolved"];
  },
): PlatformModels {
  const get: PlatformModels["get"] =
    overrides?.get ??
    ((role: LanguageRole): LanguageModelV3 => {
      if (overrides?.[role]) {
        return overrides[role];
      }
      return createStubLanguageModel(role);
    });
  const getImageResolved: PlatformModels["getImageResolved"] =
    overrides?.getImageResolved ??
    ((): { key: string; model: ImageModelV3 } => ({
      key: overrides?.imageOverlayKey ?? "google:gemini-2.5-flash-image",
      model: overrides?.image ?? createStubImageModel(),
    }));
  return {
    get,
    getImageResolved,
    // No-op reload. Tests that exercise the live-reload path should construct
    // a real `createPlatformModels` (or assert against this stub's call).
    reload(): void {},
  };
}
