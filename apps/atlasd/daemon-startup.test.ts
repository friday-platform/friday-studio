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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { PlatformModels } from "@atlas/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtlasDaemon } from "./src/atlas-daemon.ts";

/**
 * `getPlatformModels` is a daemon-internal accessor not exposed on the
 * public type — narrow through the daemon's known interface so test
 * assertions can read `.provider` / `.modelId` without resorting to `any`.
 */
function getPlatformModels(daemon: AtlasDaemon): PlatformModels {
  return (daemon as unknown as { getPlatformModels: () => PlatformModels }).getPlatformModels();
}

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
  let tempHome: string | null = null;
  // Defensive: tests that throw mid-run between initialize() and
  // shutdown() would otherwise leak a child nats-server holding the
  // reserved port. Tests assign `activeDaemon = ...` after construction;
  // afterEach unconditionally shuts it down. The shutdown call is
  // idempotent so explicit shutdown() inside a passing test is fine.
  let activeDaemon: AtlasDaemon | null = null;

  beforeEach(async () => {
    resetEnv();
    vi.clearAllMocks();
    // Pin FRIDAY_HOME to a tempdir so daemon.initialize() doesn't touch
    // the developer's real `~/.friday/local/` (which is occupied if
    // Studio.app is installed — nats-server file lock collides). The
    // tempdir gets cleaned in afterEach.
    tempHome = await mkdtemp(join(tmpdir(), "atlasd-startup-test-"));
    process.env.FRIDAY_HOME = tempHome;
  });

  afterEach(async () => {
    // Belt-and-suspenders: even if the test forgot or threw, kill any
    // spawned nats-server tied to this test's home before nuking the
    // tempdir. Errors are swallowed — the test framework will surface
    // any actual assertion failure separately.
    if (activeDaemon) {
      try {
        await activeDaemon.shutdown();
      } catch {
        // Already shut down or never fully initialized — fine.
      }
      activeDaemon = null;
    }
    // Restore original env
    Object.assign(process.env, ORIGINAL_ENV);
    // Clear out any new keys that were added
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key];
      }
    }
    if (tempHome) {
      await rm(tempHome, { recursive: true, force: true });
      tempHome = null;
    }
  });

  describe("valid yaml configuration", () => {
    it(
      "boots successfully with anthropic credentials and resolves all roles",
      async () => {
        // Minimal valid config: just set ANTHROPIC_API_KEY for the default chain
        setCredential("ANTHROPIC_API_KEY", "test-key");

        const daemon = new AtlasDaemon({ port: 0 });
        activeDaemon = daemon; // port 0 = random free port

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
      "boots successfully and resolves labels from the anthropic default even when GROQ_API_KEY is set",
      async () => {
        // Regression guard: a stray GROQ_API_KEY in the environment must NOT
        // silently hijack the labels role. Default chain leads with anthropic.
        setCredential("GROQ_API_KEY", "test-groq-key");
        setCredential("ANTHROPIC_API_KEY", "test-anthropic-key");

        const daemon = new AtlasDaemon({ port: 0 });
        activeDaemon = daemon;
        await daemon.initialize();

        const labels = getPlatformModels(daemon).get("labels");
        expect(labels.provider).toContain("anthropic");
        expect(labels.modelId).toBe("claude-haiku-4-5");

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
        activeDaemon = daemon;

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
          activeDaemon = daemon;
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
          activeDaemon = daemon;
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
        activeDaemon = daemon;
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
      "uses anthropic for labels by default even when both groq and anthropic are credentialed",
      async () => {
        setCredential("GROQ_API_KEY", "test-groq-key");
        setCredential("ANTHROPIC_API_KEY", "test-anthropic-key");

        const daemon = new AtlasDaemon({ port: 0 });
        activeDaemon = daemon;
        await daemon.initialize();

        // Groq is opt-in via `models.labels` in friday.yml / settings — env
        // var alone is not enough. Assert the resolved identity, not just
        // that something resolved (toBeDefined would pass for groq too).
        const labels = getPlatformModels(daemon).get("labels");
        expect(labels.provider).toContain("anthropic");
        expect(labels.modelId).toBe("claude-haiku-4-5");

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
        activeDaemon = daemon;
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
          activeDaemon = daemon;
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
