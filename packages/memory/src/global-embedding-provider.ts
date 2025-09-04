/**
 * Global Singleton Embedding Provider for Atlas
 *
 * Provides a shared ONNX embedding provider instance to eliminate wasteful
 * per-session initialization of identical model data (~200MB per session).
 *
 * Thread-safe and stateless - safe for concurrent access across sessions.
 */

import { WebEmbeddingProvider } from "./web-embedding-provider.ts";
import type { AtlasEmbeddingConfig, MECMFEmbeddingProvider } from "./mecmf-interfaces.ts";
import { getMECMFCacheDir } from "@atlas/utils";
import { logger } from "@atlas/logger";

/**
 * Global singleton wrapper for WebEmbeddingProvider
 */
export class GlobalEmbeddingProvider {
  private static instance: WebEmbeddingProvider | null = null;
  private static initializationPromise: Promise<WebEmbeddingProvider> | null = null;
  private static referenceCount: number = 0;
  // Lazy initialization to avoid circular dependency issues
  private static _logger: ReturnType<typeof logger.child> | null = null;

  private static get logger() {
    if (!this._logger) {
      this._logger = logger.child({ component: "GlobalEmbeddingProvider" });
    }
    return this._logger;
  }

  /**
   * Get the global singleton embedding provider instance
   */
  static async getInstance(
    config?: Partial<AtlasEmbeddingConfig>,
  ): Promise<MECMFEmbeddingProvider> {
    // If we have an initialization in progress, wait for it
    if (GlobalEmbeddingProvider.initializationPromise) {
      const instance = await GlobalEmbeddingProvider.initializationPromise;
      GlobalEmbeddingProvider.referenceCount++;
      GlobalEmbeddingProvider.logger.debug("Reusing existing embedding provider instance", {
        referenceCount: GlobalEmbeddingProvider.referenceCount,
      });
      return instance;
    }

    // If we already have an instance, increment reference and return it
    if (GlobalEmbeddingProvider.instance) {
      GlobalEmbeddingProvider.referenceCount++;
      GlobalEmbeddingProvider.logger.debug("Reusing existing embedding provider instance", {
        referenceCount: GlobalEmbeddingProvider.referenceCount,
      });
      return GlobalEmbeddingProvider.instance;
    }

    // Create new instance with initialization promise to handle concurrent requests
    GlobalEmbeddingProvider.initializationPromise = GlobalEmbeddingProvider.createInstance(config);

    try {
      const instance = await GlobalEmbeddingProvider.initializationPromise;
      GlobalEmbeddingProvider.instance = instance;
      GlobalEmbeddingProvider.referenceCount++;
      GlobalEmbeddingProvider.logger.info("Created new global embedding provider instance", {
        referenceCount: GlobalEmbeddingProvider.referenceCount,
        modelInfo: instance.getModelInfo(),
      });
      return instance;
    } finally {
      // Clear the initialization promise regardless of success/failure
      GlobalEmbeddingProvider.initializationPromise = null;
    }
  }

  /**
   * Create a new WebEmbeddingProvider instance with default config
   */
  private static async createInstance(
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

    GlobalEmbeddingProvider.logger.info("Global embedding provider initialized successfully", {
      modelInfo: provider.getModelInfo(),
      dimension: provider.getDimension(),
      ready: provider.isReady(),
    });

    return provider;
  }

  /**
   * Release a reference to the global instance
   * Note: The singleton is never actually disposed, as it's shared across all sessions
   */
  static releaseReference(): void {
    if (GlobalEmbeddingProvider.referenceCount > 0) {
      GlobalEmbeddingProvider.referenceCount--;
      GlobalEmbeddingProvider.logger.debug("Released embedding provider reference", {
        referenceCount: GlobalEmbeddingProvider.referenceCount,
      });
    }
  }

  /**
   * Force disposal of the global instance (use with caution - only for shutdown)
   */
  static async forceDispose(): Promise<void> {
    if (GlobalEmbeddingProvider.instance) {
      GlobalEmbeddingProvider.logger.info("Force disposing global embedding provider");
      await GlobalEmbeddingProvider.instance.dispose();
      GlobalEmbeddingProvider.instance = null;
      GlobalEmbeddingProvider.referenceCount = 0;
    }
  }

  /**
   * Get current reference count (for debugging/monitoring)
   */
  static getReferenceCount(): number {
    return GlobalEmbeddingProvider.referenceCount;
  }

  /**
   * Check if instance is currently initialized
   */
  static isInitialized(): boolean {
    return GlobalEmbeddingProvider.instance?.isReady() ?? false;
  }
}

/**
 * Convenience function to get the global embedding provider
 */
export async function getGlobalEmbeddingProvider(
  config?: Partial<AtlasEmbeddingConfig>,
): Promise<MECMFEmbeddingProvider> {
  return await GlobalEmbeddingProvider.getInstance(config);
}
