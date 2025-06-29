/**
 * Template adapter interface for Atlas workspace initialization
 * Abstracts template operations from specific storage implementations
 */

/**
 * Information about a workspace template
 */
export interface TemplateInfo {
  /** Unique identifier for the template */
  id: string;
  /** Display name for the template */
  name: string;
  /** Description of what the template provides */
  description: string;
  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Complete template data including files and metadata
 */
export interface Template {
  /** Template metadata */
  info: TemplateInfo;
  /** Map of relative file paths to file contents */
  files: Map<string, string>;
  /** Optional template-specific configuration */
  config?: Record<string, unknown>;
}

/**
 * Interface for template storage adapters
 * Allows different implementations (filesystem, remote registry, etc.)
 */
export interface TemplateStorageAdapter {
  /**
   * List all available templates
   * @returns Array of template information
   */
  listTemplates(): Promise<TemplateInfo[]>;

  /**
   * Get complete template data by ID
   * @param templateId The unique template identifier
   * @returns The complete template including files
   * @throws Error if template not found
   */
  getTemplate(templateId: string): Promise<Template>;

  /**
   * Copy a template to a target directory with placeholder replacements
   * @param templateId The template to copy
   * @param targetPath The destination directory
   * @param replacements Key-value pairs for placeholder substitution
   * @throws Error if template not found or copy fails
   */
  copyTemplate(
    templateId: string,
    targetPath: string,
    replacements: Record<string, string>,
  ): Promise<void>;

  /**
   * Check if a template exists
   * @param templateId The template identifier to check
   * @returns True if template exists, false otherwise
   */
  templateExists(templateId: string): Promise<boolean>;
}
