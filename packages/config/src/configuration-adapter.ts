/**
 * Configuration adapter interface for Atlas
 * Abstracts configuration loading from specific storage implementations
 */

/**
 * Interface for configuration storage adapters
 * Allows different implementations (filesystem, S3, database, etc.)
 */
export interface ConfigurationAdapter {
  /**
   * Read and parse a YAML file from storage
   * @param path The path to the YAML file
   * @returns The parsed YAML content as an object
   */
  readYaml(path: string): Promise<unknown>;

  /**
   * Check if a file exists in storage
   * @param path The path to check
   * @returns True if the file exists, false otherwise
   */
  exists(path: string): Promise<boolean>;

  /**
   * Get the workspace path
   * @returns The workspace directory path
   */
  getWorkspacePath(): string;
}
