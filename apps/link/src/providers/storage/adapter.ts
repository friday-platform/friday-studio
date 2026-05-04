import type { DynamicProviderInput } from "../types.ts";

/**
 * Storage adapter interface for dynamic provider definitions.
 *
 * Handles persistence of user-registered OAuth and API key providers.
 * Single implementation today (LocalProviderStorageAdapter, Deno KV).
 *
 * @see LocalProviderStorageAdapter
 */
export interface ProviderStorageAdapter {
  /**
   * Store a new dynamic provider.
   * @throws Error if provider ID already exists
   */
  add(provider: DynamicProviderInput): Promise<void>;

  /**
   * Get a provider by ID.
   * @returns provider definition or null if not found
   */
  get(id: string): Promise<DynamicProviderInput | null>;

  /**
   * List all dynamic providers.
   */
  list(): Promise<DynamicProviderInput[]>;

  /**
   * Delete a provider by ID.
   * @returns true if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;
}
