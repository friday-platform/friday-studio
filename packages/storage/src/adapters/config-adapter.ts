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
   * Load and parse a YAML file from storage
   * @param path The path to the YAML file
   * @returns The parsed YAML content as an object
   */
  loadYamlFile(path: string): Promise<unknown>;

  /**
   * Check if a file exists in storage
   * @param path The path to check
   * @returns True if the file exists, false otherwise
   */
  fileExists(path: string): Promise<boolean>;

  /**
   * Resolve the path to atlas.yml configuration
   * Checks in order: current working directory, git root, XDG config
   * @param workspaceDir The workspace directory to start from
   * @returns The resolved path to atlas.yml
   */
  resolveAtlasConfigPath(workspaceDir: string): Promise<string>;

  /**
   * Resolve the path to workspace.yml configuration
   * @param workspaceDir The workspace directory
   * @returns The resolved path to workspace.yml
   */
  resolveWorkspaceConfigPath(workspaceDir: string): Promise<string>;

  /**
   * Load all job specification files from a directory
   * @param jobsDir The directory containing job files
   * @returns Map of job name to job specification
   */
  loadJobFiles(jobsDir: string): Promise<Map<string, unknown>>;

  /**
   * Load supervisor default configuration
   * @returns The supervisor defaults object
   */
  loadSupervisorDefaults(): Promise<unknown>;
}
