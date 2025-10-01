/**
 * Global Singleton Embedding Provider for Atlas
 *
 * Provides a shared ONNX embedding provider instance to eliminate wasteful
 * per-session initialization of identical model data (~200MB per session).
 *
 * Thread-safe and stateless - safe for concurrent access across sessions.
 */

import { logger } from "@atlas/logger";
import { getMECMFCacheDir } from "@atlas/utils/paths.server";
import type { AtlasEmbeddingConfig, MECMFEmbeddingProvider } from "./mecmf-interfaces.ts";
import { WebEmbeddingProvider } from "./web-embedding-provider.ts";

/**
 * Global singleton state for WebEmbeddingProvider
 */
let instance: WebEmbeddingProvider | null = null;
let initializationPromise: Promise<WebEmbeddingProvider> | null = null;
// Lazy initialization to avoid circular dependency issues
let _logger: ReturnType<typeof logger.child> | null = null;

function getLogger() {
  if (!_logger) {
    _logger = logger.child({ component: "GlobalEmbeddingProvider" });
  }
  return _logger;
}

/**
 * Create a new WebEmbeddingProvider instance with default config
 */
async function createInstance(
  config?: Partial<AtlasEmbeddingConfig>,
): Promise<WebEmbeddingProvider> {
  const defaultConfig: Partial<AtlasEmbeddingConfig> = {
    model: "sentence-transformers/all-MiniLM-L6-v2",
    backend: "wasm",
    batchSize: 10,
    maxSequenceLength: 512,
    cacheDirectory: getMECMFCacheDir(),
    tokenizerConfig: {
      doLowerCase: true,
      maxLength: 512,
      padTokenId: 0,
      unkTokenId: 100,
      clsTokenId: 101,
      sepTokenId: 102,
    },
    ...config,
  };

  const provider = new WebEmbeddingProvider(defaultConfig);

  // Perform explicit initialization and warmup
  await provider.warmup();

  getLogger().info("Global embedding provider initialized successfully", {
    modelInfo: provider.getModelInfo(),
    dimension: provider.getDimension(),
    ready: provider.isReady(),
  });

  return provider;
}

/**
 * Get the global singleton embedding provider instance
 */
export async function embeddingProviderGetInstance(
  config?: Partial<AtlasEmbeddingConfig>,
): Promise<MECMFEmbeddingProvider> {
  // If we have an initialization in progress, wait for it
  if (initializationPromise) {
    const providerInstance = await initializationPromise;
    getLogger().debug("Reusing existing embedding provider instance");
    return providerInstance;
  }

  // If we already have an instance, increment reference and return it
  if (instance) {
    getLogger().debug("Reusing existing embedding provider instance");
    return instance;
  }

  // Create new instance with initialization promise to handle concurrent requests
  initializationPromise = createInstance(config);

  try {
    const providerInstance = await initializationPromise;
    instance = providerInstance;
    getLogger().info("Created new global embedding provider instance", {
      modelInfo: providerInstance.getModelInfo(),
    });
    // Clear promise on success - it's no longer needed
    initializationPromise = null;
    return providerInstance;
  } catch (error) {
    // CRITICAL: Keep the failed promise to prevent runaway retries
    // The failed promise will be returned to all subsequent callers
    // preventing the creation of new initialization attempts
    getLogger().error("Failed to create global embedding provider instance", { error });
    throw error;
  }
}

/**
 * Force disposal of the global instance (use with caution - only for shutdown)
 */
export async function embeddingProviderForceDispose(): Promise<void> {
  if (instance) {
    getLogger().info("Force disposing global embedding provider");
    await instance.dispose();
    instance = null;
  }
}

/**
 * Check if instance is currently initialized
 */
export function embeddingProviderIsInitialized(): boolean {
  return instance?.isReady() ?? false;
}

/**
 * Convenience function to get the global embedding provider
 */
export async function getGlobalEmbeddingProvider(
  config?: Partial<AtlasEmbeddingConfig>,
): Promise<MECMFEmbeddingProvider> {
  return await embeddingProviderGetInstance(config);
}
