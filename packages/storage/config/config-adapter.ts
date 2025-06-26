/**
 * Configuration adapter interface for loading Atlas and workspace configurations
 * from various sources (filesystem, remote storage, etc.)
 */

// Import types from the shared types package
import type {
  AtlasConfig,
  JobSpecification,
  SupervisorDefaults,
  WorkspaceConfig,
} from "@atlas/types";

/**
 * Interface for configuration adapters that can load Atlas and workspace configurations
 * from different sources
 */
export interface IConfigurationAdapter {
  /**
   * Load the Atlas platform configuration
   * @returns The parsed and validated Atlas configuration
   */
  loadAtlasConfig(): Promise<AtlasConfig>;

  /**
   * Load the workspace configuration
   * @returns The parsed and validated workspace configuration
   */
  loadWorkspaceConfig(): Promise<WorkspaceConfig>;

  /**
   * Load job specifications from various sources
   * @returns A record of job names to job specifications
   */
  loadJobSpecs(): Promise<Record<string, JobSpecification>>;

  /**
   * Load supervisor default configurations
   * @returns The supervisor defaults object
   */
  loadSupervisorDefaults(): Promise<SupervisorDefaults>;
}
