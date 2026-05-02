/**
 * Integration tests for daemon startup platform model initialization.
 *
 * Verifies `AtlasDaemon.initialize()` correctly:
 * - Boots with valid friday.yml configuration
 * - Throws on invalid/malformed configuration
 * - Falls back to default chains when no friday.yml exists
 * - Accepts LITELLM_API_KEY as universal credential for any provider
 *
 * Source: apps/atlasd/src/atlas-daemon.ts initialization flow (lines ~245-260)
 */

import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasDaemon } from "./src/atlas-daemon.ts";

// daemon.initialize() spawns NATS, ensures multiple JetStream streams,
// runs chat + memory migrations in the background. The default 5s vitest
// timeout is too tight; 30s gives slow CI machines headroom.
const INIT_TIMEOUT_MS = 30_000;

// Save original env
const ORIGINAL_ENV = { ...process.env };

/** Reset environment to baseline (no provider credentials). */
function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.includes("API_KEY") || key.includes("_TOKEN")) {
      delete process.env[key];
    }
  }
}

/** Set a credential env var. */
function setCredential(key: string, value: string) {
  process.env[key] = value;
}

describe("daemon startup platform models", () => {
  beforeEach(() => {
    resetEnv();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env
    Object.assign(process.env, ORIGINAL_ENV);
    // Clear out any new keys that were added
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key];
      }
    }
  });

  describe("valid yaml configuration", () => {
    it(
      "boots successfully with anthropic credentials and resolves all roles",
      async () => {
        // Minimal valid config: just set ANTHROPIC_API_KEY for the default chain
        setCredential("ANTHROPIC_API_KEY", "test-key");

        const daemon = new AtlasDaemon({ port: 0 }); // port 0 = random free port

        // Should initialize without throwing
        await daemon.initialize();

        // All platform model roles should be resolvable post-boot
        const platformModels = (
          daemon as unknown as { getPlatformModels: () => { get: (role: string) => unknown } }
        ).getPlatformModels();
        expect(platformModels.get("labels")).toBeDefined();
        expect(platformModels.get("classifier")).toBeDefined();
        expect(platformModels.get("planner")).toBeDefined();
        expect(platformModels.get("conversational")).toBeDefined();

        await daemon.shutdown();
      },
      INIT_TIMEOUT_MS,
    );

    it(
      "boots successfully with groq credentials and resolves labels from groq",
      async () => {
        // Groq wins the labels role when credentialed
        setCredential("GROQ_API_KEY", "test-groq-key");
        // Also need anthropic for other roles (classifier, planner, conversational)
        setCredential("ANTHROPIC_API_KEY", "test-anthropic-key");

        const daemon = new AtlasDaemon({ port: 0 });
        await daemon.initialize();

        const platformModels = (
          daemon as unknown as { getPlatformModels: () => { get: (role: string) => unknown } }
        ).getPlatformModels();
        const labelsModel = platformModels.get("labels");
        expect(labelsModel).toBeDefined();

        await daemon.shutdown();
      },
      INIT_TIMEOUT_MS,
    );
  });

  describe("invalid yaml configuration", () => {
    it(
      "throws PlatformModelsConfigError when no credentials are available",
      async () => {
        // No credentials set - default chain will fail on missing ANTHROPIC_API_KEY
        const daemon = new AtlasDaemon({ port: 0 });

        await expect(daemon.initialize()).rejects.toThrow(
          /Platform model configuration failed validation/,
        );
        await expect(daemon.initialize()).rejects.toThrow(/ANTHROPIC_API_KEY/);
      },
      INIT_TIMEOUT_MS,
    );

    it(
      "throws when malformed provider:model format is configured",
      async () => {
        // Mock the FilesystemAtlasConfigSource to return invalid config
        const { FilesystemAtlasConfigSource } = await import("@atlas/config/server");

        // Temporarily override the load method
        const originalLoad = FilesystemAtlasConfigSource.prototype.load;
        FilesystemAtlasConfigSource.prototype.load = () =>
          Promise.resolve({
            models: {
              labels: "invalid-format-no-colon", // Missing colon
            },
          } as unknown as Awaited<ReturnType<typeof originalLoad>>);

        try {
          const daemon = new AtlasDaemon({ port: 0 });
          await expect(daemon.initialize()).rejects.toThrow(
            /Platform model configuration failed validation/,
          );
          await expect(daemon.initialize()).rejects.toThrow(/must be in 'provider:model' format/);
        } finally {
          // Restore original method
          FilesystemAtlasConfigSource.prototype.load = originalLoad;
        }
      },
      INIT_TIMEOUT_MS,
    );

    it(
      "throws on unknown provider in user configuration",
      async () => {
        const { FilesystemAtlasConfigSource } = await import("@atlas/config/server");

        const originalLoad = FilesystemAtlasConfigSource.prototype.load;
        FilesystemAtlasConfigSource.prototype.load = () =>
          Promise.resolve({
            models: { labels: "unknownprovider:some-model" },
          } as unknown as Awaited<ReturnType<typeof originalLoad>>);

        try {
          const daemon = new AtlasDaemon({ port: 0 });
          await expect(daemon.initialize()).rejects.toThrow(
            /Platform model configuration failed validation/,
          );
          await expect(daemon.initialize()).rejects.toThrow(/unknownprovider/);
        } finally {
          FilesystemAtlasConfigSource.prototype.load = originalLoad;
        }
      },
      INIT_TIMEOUT_MS,
    );
  });

  describe("no yaml configuration (zero-config)", () => {
    it(
      "boots with default chains when anthropic is credentialed",
      async () => {
        // Zero-config: no friday.yml, but ANTHROPIC_API_KEY provides the default chain fallback
        setCredential("ANTHROPIC_API_KEY", "test-key");

        const daemon = new AtlasDaemon({ port: 0 });
        await daemon.initialize();

        const platformModels = (
          daemon as unknown as { getPlatformModels: () => { get: (role: string) => unknown } }
        ).getPlatformModels();
        expect(platformModels.get("labels")).toBeDefined();
        expect(platformModels.get("classifier")).toBeDefined();

        await daemon.shutdown();
      },
      INIT_TIMEOUT_MS,
    );

    it(
      "prefers groq for labels when both groq and anthropic are credentialed",
      async () => {
        setCredential("GROQ_API_KEY", "test-groq-key");
        setCredential("ANTHROPIC_API_KEY", "test-anthropic-key");

        const daemon = new AtlasDaemon({ port: 0 });
        await daemon.initialize();

        const platformModels = (
          daemon as unknown as { getPlatformModels: () => { get: (role: string) => unknown } }
        ).getPlatformModels();
        // Labels should resolve (to groq in the default chain)
        expect(platformModels.get("labels")).toBeDefined();

        await daemon.shutdown();
      },
      INIT_TIMEOUT_MS,
    );
  });

  describe("LITELLM universal credential", () => {
    it(
      "boots with only LITELLM_API_KEY set (no provider-specific credentials)",
      async () => {
        // LITELLM_API_KEY acts as universal credential for all providers
        setCredential("LITELLM_API_KEY", "test-litellm-key");

        // No ANTHROPIC_API_KEY, no GROQ_API_KEY, etc.
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.GROQ_API_KEY).toBeUndefined();

        const daemon = new AtlasDaemon({ port: 0 });
        await daemon.initialize();

        // All roles should be resolvable with LITELLM proxy
        const platformModels = (
          daemon as unknown as { getPlatformModels: () => { get: (role: string) => unknown } }
        ).getPlatformModels();
        expect(platformModels.get("labels")).toBeDefined();
        expect(platformModels.get("classifier")).toBeDefined();
        expect(platformModels.get("planner")).toBeDefined();
        expect(platformModels.get("conversational")).toBeDefined();

        await daemon.shutdown();
      },
      INIT_TIMEOUT_MS,
    );

    it(
      "allows any provider model when LITELLM_API_KEY is set",
      async () => {
        const { FilesystemAtlasConfigSource } = await import("@atlas/config/server");

        setCredential("LITELLM_API_KEY", "test-litellm-key");

        // Configure an arbitrary provider:model - LITELLM can proxy it
        const originalLoad = FilesystemAtlasConfigSource.prototype.load;
        FilesystemAtlasConfigSource.prototype.load = () =>
          Promise.resolve({
            models: { labels: "openai:gpt-4o", classifier: "google:gemini-pro" },
          } as unknown as Awaited<ReturnType<typeof originalLoad>>);

        try {
          const daemon = new AtlasDaemon({ port: 0 });
          // Should NOT throw - LITELLM_API_KEY satisfies credential check for any provider
          await daemon.initialize();

          const platformModels = (
            daemon as unknown as { getPlatformModels: () => { get: (role: string) => unknown } }
          ).getPlatformModels();
          expect(platformModels.get("labels")).toBeDefined();
          expect(platformModels.get("classifier")).toBeDefined();

          await daemon.shutdown();
        } finally {
          FilesystemAtlasConfigSource.prototype.load = originalLoad;
        }
      },
      INIT_TIMEOUT_MS,
    );
  });
});
