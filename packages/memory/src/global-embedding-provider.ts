/**
 * Global Singleton Embedding Provider for Atlas
 *
 * Provides a shared ONNX embedding provider instance to eliminate wasteful
 * per-session initialization of identical model data (~200MB per session).
 *
 * Thread-safe and stateless - safe for concurrent access across sessions.
 */

import { logger } from "@atlas/logger";
import { getMECMFCacheDir } from "@atlas/utils";
import type { AtlasEmbeddingConfig, MECMFEmbeddingProvider } from "./mecmf-interfaces.ts";
import { WebEmbeddingProvider } from "./web-embedding-provider.ts";

/**
 * Global singleton state for WebEmbeddingProvider
 */
let instance: WebEmbeddingProvider | null = null;
let initializationPromise: Promise<WebEmbeddingProvider> | null = null;
let referenceCount: number = 0;
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
    referenceCount++;
    getLogger().debug("Reusing existing embedding provider instance", { referenceCount });
    return providerInstance;
  }

  // If we already have an instance, increment reference and return it
  if (instance) {
    referenceCount++;
    getLogger().debug("Reusing existing embedding provider instance", { referenceCount });
    return instance;
  }

  // Create new instance with initialization promise to handle concurrent requests
  initializationPromise = createInstance(config);

  try {
    const providerInstance = await initializationPromise;
    instance = providerInstance;
    referenceCount++;
    getLogger().info("Created new global embedding provider instance", {
      referenceCount,
      modelInfo: providerInstance.getModelInfo(),
    });
    return providerInstance;
  } finally {
    // Clear the initialization promise regardless of success/failure
    initializationPromise = null;
  }
}

/**
 * Release a reference to the global instance
 * Note: The singleton is never actually disposed, as it's shared across all sessions
 */
export function embeddingProviderReleaseReference(): void {
  if (referenceCount > 0) {
    referenceCount--;
    getLogger().debug("Released embedding provider reference", { referenceCount });
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
    referenceCount = 0;
  }
}

/**
 * Get current reference count (for debugging/monitoring)
 */
export function embeddingProviderGetReferenceCount(): number {
  return referenceCount;
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
