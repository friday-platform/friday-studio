/**
 * Signal Analysis Framework
 * Analyzes incoming signals to understand their meaning and extract key information
 */

import { logger } from "../../utils/logger.ts";
import type { SignalAnalysis, SignalPattern, SignalTrigger } from "./types.ts";

export class SignalAnalyzer {
  private patterns: SignalPattern[] = [];

  constructor(patterns: SignalPattern[] = []) {
    this.patterns = patterns;
  }

  /**
   * Add signal patterns for analysis
   */
  addPatterns(patterns: SignalPattern[]): void {
    this.patterns.push(...patterns);
    logger.debug("Added signal patterns", {
      newPatterns: patterns.length,
      totalPatterns: this.patterns.length,
    });
  }

  /**
   * Analyze a signal and extract meaningful information
   */
  async analyze(signal: any): Promise<SignalAnalysis> {
    logger.debug("Analyzing signal", {
      signalKeys: Object.keys(signal),
      signalType: typeof signal,
    });

    // Find matching patterns
    const matchingPatterns = this.findMatchingPatterns(signal);

    if (matchingPatterns.length === 0) {
      // Default analysis for unknown signals
      return this.createDefaultAnalysis(signal);
    }

    // Use the highest priority matching pattern
    const bestPattern = this.selectBestPattern(matchingPatterns);
    
    // Extract entities based on pattern configuration
    const extractedEntities = this.extractEntities(signal, bestPattern);

    const analysis: SignalAnalysis = {
      domain: bestPattern.domain,
      category: bestPattern.category,
      severity: bestPattern.severity,
      actionType: bestPattern.actionType,
      urgency: bestPattern.urgency,
      extractedEntities,
    };

    logger.info("Signal analysis completed", {
      pattern: bestPattern.name,
      domain: analysis.domain,
      category: analysis.category,
      severity: analysis.severity,
      urgency: analysis.urgency,
      entitiesFound: Object.keys(extractedEntities).length,
    });

    return analysis;
  }

  /**
   * Find patterns that match the signal
   */
  private findMatchingPatterns(signal: any): SignalPattern[] {
    return this.patterns.filter(pattern => {
      return pattern.triggers.every(trigger => this.evaluateTrigger(signal, trigger));
    });
  }

  /**
   * Evaluate if a trigger matches the signal
   */
  private evaluateTrigger(signal: any, trigger: SignalTrigger): boolean {
    const fieldValue = this.getFieldValue(signal, trigger.field);
    
    if (fieldValue === undefined || fieldValue === null) {
      return false;
    }

    const operator = trigger.operator || "=";

    switch (operator) {
      case "=":
        return fieldValue === trigger.value;
      case "!=":
        return fieldValue !== trigger.value;
      case ">":
        return typeof fieldValue === "number" && fieldValue > (trigger.threshold || trigger.value);
      case "<":
        return typeof fieldValue === "number" && fieldValue < (trigger.threshold || trigger.value);
      case ">=":
        return typeof fieldValue === "number" && fieldValue >= (trigger.threshold || trigger.value);
      case "<=":
        return typeof fieldValue === "number" && fieldValue <= (trigger.threshold || trigger.value);
      case "contains":
        return typeof fieldValue === "string" && fieldValue.includes(trigger.value);
      case "matches":
        if (trigger.regex) {
          const regex = new RegExp(trigger.regex);
          return regex.test(String(fieldValue));
        }
        return false;
      default:
        logger.warn("Unknown trigger operator", { operator });
        return false;
    }
  }

  /**
   * Get field value using dot notation
   */
  private getFieldValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * Select the best matching pattern (highest urgency)
   */
  private selectBestPattern(patterns: SignalPattern[]): SignalPattern {
    return patterns.reduce((best, current) => {
      return current.urgency > best.urgency ? current : best;
    });
  }

  /**
   * Extract entities from signal based on pattern configuration
   */
  private extractEntities(signal: any, pattern: SignalPattern): Record<string, any> {
    const entities: Record<string, any> = {};

    if (!pattern.entityExtraction) {
      return entities;
    }

    for (const extraction of pattern.entityExtraction) {
      const value = this.getFieldValue(signal, extraction.field);
      
      if (value !== undefined) {
        entities[extraction.name] = extraction.transform ? 
          this.applyTransform(value, extraction.transform) : value;
      } else if (extraction.required) {
        logger.warn("Required entity field missing", {
          pattern: pattern.name,
          field: extraction.field,
          entity: extraction.name,
        });
      }
    }

    return entities;
  }

  /**
   * Apply transformation to extracted value
   */
  private applyTransform(value: any, transform: string): any {
    switch (transform) {
      case "lowercase":
        return String(value).toLowerCase();
      case "uppercase":
        return String(value).toUpperCase();
      case "trim":
        return String(value).trim();
      case "number":
        return Number(value);
      default:
        return value;
    }
  }

  /**
   * Create default analysis for unknown signals
   */
  private createDefaultAnalysis(signal: any): SignalAnalysis {
    return {
      domain: "unknown",
      category: "general",
      severity: "medium",
      actionType: "investigate",
      urgency: 5,
      extractedEntities: {
        raw_signal: signal,
      },
    };
  }
}