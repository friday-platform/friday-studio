/**
 * PII-Safe Memory Classifier
 *
 * Extends the Atlas Memory Classifier with source-aware PII filtering.
 * Only allows PII extraction from trusted sources (user input) to prevent
 * accidental collection of random PII from tool outputs or external data.
 */

import { logger } from "@atlas/logger";
import {
  type ConversationContext,
  type Entity,
  MemorySource,
  type MemorySourceMetadata,
} from "./mecmf-interfaces.ts";
import { AtlasMemoryClassifier } from "./memory-classifier.ts";

interface PIIExtractionConfig {
  // PII types that require source filtering
  restrictedPIITypes: string[];
  // Sources that are allowed to provide PII
  trustedSources: MemorySource[];
  // Enable/disable specific PII extraction
  extractEmails: boolean;
  extractPhones: boolean;
  extractNames: boolean;
  // Confidence threshold for PII extraction
  minPIIConfidence: number;
}

export class PIISafeMemoryClassifier extends AtlasMemoryClassifier {
  private config: PIIExtractionConfig;

  constructor(config?: Partial<PIIExtractionConfig>) {
    super();

    this.config = {
      restrictedPIITypes: ["email", "phone", "name"],
      trustedSources: [MemorySource.USER_INPUT],
      extractEmails: true,
      extractPhones: true,
      extractNames: true,
      minPIIConfidence: 0.7,
      ...config,
    };
  }

  /**
   * Validates and sanitizes content before processing
   * Prevents code fragments and invalid data from being stored
   */
  private validateAndSanitizeContent(content: string): { isValid: boolean; sanitized: string } {
    // Check if content looks like code fragments
    const codeIndicators = [
      /function\s+\w+\s*\(.*\)\s*\{/, // function declarations
      /^\s*const\s+\w+\s*=/, // const declarations
      /^\s*let\s+\w+\s*=/, // let declarations
      /^\s*var\s+\w+\s*=/, // var declarations
      /op_\w+\(/, // Deno internal functions
      /\$\{.*\}/, // template literals
      /import\s+.*from/, // imports
      /export\s+.*\{/, // exports
    ];

    // Check if content contains multiple code indicators (likely a code fragment)
    let codeIndicatorCount = 0;
    for (const pattern of codeIndicators) {
      if (pattern.test(content)) {
        codeIndicatorCount++;
      }
    }

    // If multiple code indicators are found, this is likely a code fragment
    if (codeIndicatorCount >= 2) {
      return {
        isValid: false,
        sanitized: `[Code fragment detected and excluded from memory storage]`,
      };
    }

    // Check for extremely long single lines (likely minified code or malformed data)
    // But allow repeated patterns (like repeated emails in tests)
    const lines = content.split("\n");
    const hasExtremelyLongLine = lines.some((line) => line.length > 1000);

    // Check if it's likely code by looking for code patterns in long lines
    const looksLikeCode =
      hasExtremelyLongLine &&
      (content.includes("function") ||
        content.includes("const ") ||
        content.includes("=>") ||
        content.includes("{") ||
        content.includes("}"));

    if (hasExtremelyLongLine && content.length > 2000 && looksLikeCode) {
      return {
        isValid: false,
        sanitized: `[Large code/data fragment detected and excluded from memory storage]`,
      };
    }

    // Sanitize content by removing excessive whitespace and normalizing
    const sanitized = content
      .replace(/\s+/g, " ") // Replace multiple whitespace with single space
      .replace(/^\s+|\s+$/g, "") // Trim leading/trailing whitespace
      .substring(0, 5000); // Limit content length

    return { isValid: true, sanitized };
  }

  /**
   * Override classifyContent to add content validation
   */
  override classifyContent(content: string, context: ConversationContext) {
    // Validate and sanitize content before classification
    const validation = this.validateAndSanitizeContent(content);

    if (!validation.isValid) {
      // Log the rejected content for debugging
      logger.warn(`Content rejected from memory storage: ${content.substring(0, 100)}...`);

      // Return a safe default for invalid content
      return super.classifyContent(validation.sanitized, context);
    }

    // Use sanitized content for classification
    return super.classifyContent(validation.sanitized, context);
  }

  /**
   * Override extractKeyEntities to add source-aware PII filtering
   */
  override extractKeyEntities(
    content: string,
    source: MemorySource = MemorySource.SYSTEM_GENERATED,
  ): Entity[] {
    // Validate content first
    const validation = this.validateAndSanitizeContent(content);
    if (!validation.isValid) {
      return []; // Return no entities for invalid content
    }

    // Get all entities using the parent implementation with sanitized content
    const allEntities = super.extractKeyEntities(validation.sanitized);

    // Filter entities based on source and PII policy
    return allEntities.filter((entity) => this.isEntityAllowedFromSource(entity, source));
  }

  /**
   * Check if an entity is allowed from the given source
   */
  private isEntityAllowedFromSource(entity: Entity, source: MemorySource): boolean {
    // Always allow non-PII entities
    if (!this.isPIIType(entity.type)) {
      return true;
    }

    // Check if this specific PII type is enabled
    if (!this.isPIITypeEnabled(entity.type)) {
      return false;
    }

    // Check confidence threshold
    if (entity.confidence < this.config.minPIIConfidence) {
      return false;
    }

    // Only allow PII from trusted sources
    return this.config.trustedSources.includes(source);
  }

  /**
   * Check if an entity type is considered PII
   */
  private isPIIType(entityType: string): boolean {
    return this.config.restrictedPIITypes.includes(entityType);
  }

  /**
   * Check if a specific PII type is enabled for extraction
   */
  private isPIITypeEnabled(entityType: string): boolean {
    switch (entityType) {
      case "email":
        return this.config.extractEmails;
      case "phone":
        return this.config.extractPhones;
      case "name":
        return this.config.extractNames;
      default:
        return true; // Default to enabled for new PII types
    }
  }

  /**
   * Get source-aware classification statistics
   */
  getSourceStatistics(): {
    piiTypesRestricted: string[];
    trustedSources: MemorySource[];
    extractionSettings: { emails: boolean; phones: boolean; names: boolean };
    minConfidenceThreshold: number;
  } {
    return {
      piiTypesRestricted: [...this.config.restrictedPIITypes],
      trustedSources: [...this.config.trustedSources],
      extractionSettings: {
        emails: this.config.extractEmails,
        phones: this.config.extractPhones,
        names: this.config.extractNames,
      },
      minConfidenceThreshold: this.config.minPIIConfidence,
    };
  }

  /**
   * Update PII extraction configuration
   */
  updatePIIConfig(updates: Partial<PIIExtractionConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Check if a memory source is trusted for PII extraction
   */
  isTrustedSource(source: MemorySource): boolean {
    return this.config.trustedSources.includes(source);
  }

  /**
   * Add a trusted source for PII extraction
   */
  addTrustedSource(source: MemorySource): void {
    if (!this.config.trustedSources.includes(source)) {
      this.config.trustedSources.push(source);
    }
  }

  /**
   * Remove a trusted source for PII extraction
   */
  removeTrustedSource(source: MemorySource): void {
    this.config.trustedSources = this.config.trustedSources.filter((s) => s !== source);
  }

  /**
   * Get filtered entities with source information included
   */
  extractEntitiesWithSource(
    content: string,
    source: MemorySource,
    sourceMetadata?: MemorySourceMetadata,
  ): Array<Entity & { source: MemorySource; sourceMetadata?: MemorySourceMetadata }> {
    const entities = this.extractKeyEntities(content, source);

    return entities.map((entity) => ({ ...entity, source, sourceMetadata }));
  }
}

// Export default configuration for reference
export const DEFAULT_PII_CONFIG: PIIExtractionConfig = {
  restrictedPIITypes: ["email", "phone", "name"],
  trustedSources: [MemorySource.USER_INPUT],
  extractEmails: true,
  extractPhones: true,
  extractNames: true,
  minPIIConfidence: 0.7,
};
