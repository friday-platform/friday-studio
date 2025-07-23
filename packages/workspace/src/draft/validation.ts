/**
 * Draft Validation - Configuration validation and formatting utilities
 */

import { WorkspaceConfigSchema } from "@atlas/config";
import type { ValidationResult } from "../types.ts";

export class DraftValidator {
  static validateWorkspaceConfiguration(
    config: unknown,
  ): ValidationResult {
    try {
      WorkspaceConfigSchema.parse(config);
      return { valid: true, errors: [], warnings: [] };
    } catch (error) {
      if (error instanceof Error) {
        return { valid: false, errors: [error.message], warnings: [] };
      }
      return { valid: false, errors: ["Unknown validation error"], warnings: [] };
    }
  }

  static formatConfigForDisplay(config: unknown, format: string): string {
    switch (format) {
      case "yaml":
        return JSON.stringify(config, null, 2); // Would use YAML library in real implementation
      case "json":
        return JSON.stringify(config, null, 2);
      case "summary":
        return `Draft contains ${
          Object.keys(config as Record<string, unknown>).length
        } configuration sections`;
      default:
        return JSON.stringify(config, null, 2);
    }
  }
}
