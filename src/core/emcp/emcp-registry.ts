/**
 * EMCP Provider Registry
 *
 * Manages registration, discovery, and lifecycle of EMCP providers
 */

import type {
  ContextSpec,
  EMCPCapability,
  EMCPContext,
  EMCPResult,
  IEMCPProvider,
} from "./emcp-provider.ts";

export interface ProviderRegistration {
  readonly provider: IEMCPProvider;
  readonly sourceConfigs: Map<string, Record<string, unknown>>; // source name -> config
  readonly isInitialized: boolean;
}

export interface ProviderDiscoveryResult {
  readonly providerId: string;
  readonly capabilities: EMCPCapability[];
  readonly canHandle: boolean;
  readonly confidence: number; // 0-1, how well this provider matches the need
}

/**
 * Registry for managing EMCP providers
 */
export class EMCPRegistry {
  private providers = new Map<string, ProviderRegistration>();
  private capabilityIndex = new Map<string, Set<string>>(); // contextType -> providerIds

  /**
   * Register a provider with the registry
   */
  async registerProvider(
    providerId: string,
    provider: IEMCPProvider,
    sourceConfigs: Map<string, Record<string, unknown>> = new Map(),
  ): Promise<void> {
    // Initialize provider with combined configuration
    const combinedConfig = this.combineSourceConfigs(sourceConfigs);
    await provider.initialize(combinedConfig);

    // Register provider
    this.providers.set(providerId, {
      provider,
      sourceConfigs,
      isInitialized: true,
    });

    // Index capabilities
    this.indexProviderCapabilities(providerId, provider.config.capabilities);

    console.log(`EMCP Provider registered: ${providerId}`);
  }

  /**
   * Unregister a provider
   */
  async unregisterProvider(providerId: string): Promise<void> {
    const registration = this.providers.get(providerId);
    if (!registration) {
      return;
    }

    // Shutdown provider
    await registration.provider.shutdown();

    // Remove from capability index
    this.removeFromCapabilityIndex(providerId);

    // Remove from registry
    this.providers.delete(providerId);

    console.log(`EMCP Provider unregistered: ${providerId}`);
  }

  /**
   * Discover providers that can handle a specific context type
   */
  discoverProviders(contextType: string): ProviderDiscoveryResult[] {
    const providerIds = this.capabilityIndex.get(contextType) || new Set();
    const results: ProviderDiscoveryResult[] = [];

    for (const providerId of providerIds) {
      const registration = this.providers.get(providerId);
      if (!registration || !registration.isInitialized) {
        continue;
      }

      const provider = registration.provider;
      const canHandle = provider.canProvide(contextType);

      if (canHandle) {
        // Calculate confidence based on capability match
        const confidence = this.calculateConfidence(provider.config.capabilities, contextType);

        results.push({
          providerId,
          capabilities: provider.config.capabilities,
          canHandle,
          confidence,
        });
      }
    }

    // Sort by confidence (highest first)
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get a specific provider by ID
   */
  getProvider(providerId: string): IEMCPProvider | undefined {
    const registration = this.providers.get(providerId);
    return registration?.isInitialized ? registration.provider : undefined;
  }

  /**
   * List all registered providers
   */
  listProviders(): Array<{ id: string; provider: IEMCPProvider }> {
    const result: Array<{ id: string; provider: IEMCPProvider }> = [];

    for (const [id, registration] of this.providers.entries()) {
      if (registration.isInitialized) {
        result.push({ id, provider: registration.provider });
      }
    }

    return result;
  }

  /**
   * Provision context using the best available provider
   */
  async provisionContext(
    contextType: string,
    spec: ContextSpec,
    context: EMCPContext,
  ): Promise<EMCPResult> {
    const discoveries = this.discoverProviders(contextType);

    if (discoveries.length === 0) {
      return {
        success: false,
        error: `No providers available for context type: ${contextType}`,
      };
    }

    // Try providers in order of confidence
    for (const discovery of discoveries) {
      const provider = this.getProvider(discovery.providerId);
      if (!provider) {
        continue;
      }

      try {
        const result = await provider.provisionContext(spec, context);
        if (result.success) {
          return result;
        }

        // Log failure but try next provider
        console.warn(`Provider ${discovery.providerId} failed: ${result.error}`);
      } catch (error) {
        console.error(`Provider ${discovery.providerId} threw error:`, error);
        // Continue to next provider
      }
    }

    return {
      success: false,
      error: `All providers failed for context type: ${contextType}`,
    };
  }

  /**
   * Shutdown all providers
   */
  async shutdown(): Promise<void> {
    const shutdownPromises = Array.from(this.providers.keys()).map(
      (providerId) => this.unregisterProvider(providerId),
    );

    await Promise.allSettled(shutdownPromises);
  }

  // Private methods

  private combineSourceConfigs(
    sourceConfigs: Map<string, Record<string, unknown>>,
  ): Record<string, unknown> {
    const combined: Record<string, unknown> = {};

    for (const [sourceName, config] of sourceConfigs.entries()) {
      combined[sourceName] = config;
    }

    return combined;
  }

  private indexProviderCapabilities(providerId: string, capabilities: EMCPCapability[]): void {
    for (const capability of capabilities) {
      const contextType = capability.type;

      if (!this.capabilityIndex.has(contextType)) {
        this.capabilityIndex.set(contextType, new Set());
      }

      this.capabilityIndex.get(contextType)!.add(providerId);
    }
  }

  private removeFromCapabilityIndex(providerId: string): void {
    for (const providerIds of this.capabilityIndex.values()) {
      providerIds.delete(providerId);
    }
  }

  private calculateConfidence(capabilities: EMCPCapability[], contextType: string): number {
    const matchingCapabilities = capabilities.filter((cap) => cap.type === contextType);

    if (matchingCapabilities.length === 0) {
      return 0;
    }

    // Simple confidence calculation - could be more sophisticated
    // Factors: number of operations supported, format support, etc.
    let score = 0.5; // Base score for having the capability

    for (const capability of matchingCapabilities) {
      score += capability.operations.length * 0.1; // More operations = higher confidence
      score += capability.formats.length * 0.05; // More formats = higher confidence
    }

    return Math.min(score, 1.0); // Cap at 1.0
  }
}
