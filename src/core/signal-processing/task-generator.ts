/**
 * Task Generation System
 * Transforms analyzed signals into structured, actionable tasks
 */

import { logger } from "../../utils/logger.ts";
import type { EnhancedTask, SignalAnalysis, TaskTemplate } from "./types.ts";

export class TaskGenerator {
  private templates: TaskTemplate[] = [];

  constructor(templates: TaskTemplate[] = []) {
    this.templates = templates;
  }

  /**
   * Add task templates
   */
  addTemplates(templates: TaskTemplate[]): void {
    this.templates.push(...templates);
    logger.debug("Added task templates", {
      newTemplates: templates.length,
      totalTemplates: this.templates.length,
    });
  }

  /**
   * Generate an enhanced task from signal and analysis
   */
  async createTask(signal: any, analysis: SignalAnalysis): Promise<EnhancedTask> {
    logger.debug("Creating task from signal analysis", {
      domain: analysis.domain,
      category: analysis.category,
      actionType: analysis.actionType,
    });

    // Find matching template
    const template = this.findMatchingTemplate(analysis);
    
    if (!template) {
      return this.createDefaultTask(signal, analysis);
    }

    // Generate task using template
    const task = await this.generateFromTemplate(signal, analysis, template);

    logger.info("Task created successfully", {
      template: template.name,
      description: task.description,
      actionType: task.action.type,
      priority: task.priority,
      complexity: task.estimatedComplexity,
    });

    return task;
  }

  /**
   * Find template that matches the analysis
   */
  private findMatchingTemplate(analysis: SignalAnalysis): TaskTemplate | null {
    // Find template that matches action type and domain
    const candidates = this.templates.filter(template => {
      return template.actionType === analysis.actionType;
    });

    if (candidates.length === 0) {
      return null;
    }

    // Return first matching template (could be enhanced with better matching logic)
    return candidates[0];
  }

  /**
   * Generate task from template
   */
  private async generateFromTemplate(
    signal: any, 
    analysis: SignalAnalysis, 
    template: TaskTemplate
  ): Promise<EnhancedTask> {
    // Generate description from template
    const description = this.interpolateTemplate(
      template.descriptionTemplate, 
      analysis.extractedEntities
    );

    // Extract target information
    const target = this.extractTarget(signal, analysis);

    // Extract issue information
    const issue = this.extractIssue(signal, analysis);

    // Extract context
    const context = this.extractContext(signal);

    // Calculate priority based on urgency and severity
    const priority = this.calculatePriority(analysis);

    return {
      description,
      action: {
        type: template.actionType,
        target,
      },
      data: {
        issue,
        context,
      },
      priority,
      estimatedComplexity: template.complexity,
      requiredCapabilities: template.requiredCapabilities,
    };
  }

  /**
   * Interpolate template string with extracted entities
   */
  private interpolateTemplate(template: string, entities: Record<string, any>): string {
    let result = template;
    
    for (const [key, value] of Object.entries(entities)) {
      const placeholder = `{${key}}`;
      result = result.replace(new RegExp(placeholder, 'g'), String(value));
    }

    // Remove any remaining placeholders
    result = result.replace(/{[^}]+}/g, '[unknown]');

    return result;
  }

  /**
   * Extract target information from signal
   */
  private extractTarget(signal: any, analysis: SignalAnalysis): {
    type: string;
    identifier: string;
    metadata: Record<string, any>;
  } {
    const entities = analysis.extractedEntities;
    
    // Try to identify target type and identifier
    let targetType = entities.resource_type || entities.kind || entities.type || "unknown";
    let identifier = entities.resource_name || entities.name || entities.id || "unknown";

    // If no specific target info, use general info
    if (targetType === "unknown" && identifier === "unknown") {
      targetType = analysis.domain;
      identifier = analysis.category;
    }

    // Extract metadata
    const metadata: Record<string, any> = {};
    for (const [key, value] of Object.entries(entities)) {
      if (key !== "resource_type" && key !== "resource_name" && key !== "kind" && key !== "name") {
        metadata[key] = value;
      }
    }

    return {
      type: targetType.toLowerCase(),
      identifier,
      metadata,
    };
  }

  /**
   * Extract issue information from signal
   */
  private extractIssue(signal: any, analysis: SignalAnalysis): {
    type: string;
    description: string;
    details: Record<string, any>;
  } {
    const entities = analysis.extractedEntities;
    
    return {
      type: analysis.category,
      description: entities.error_message || entities.message || entities.description || 
                  `${analysis.category} in ${analysis.domain}`,
      details: {
        severity: analysis.severity,
        domain: analysis.domain,
        urgency: analysis.urgency,
        ...entities,
      },
    };
  }

  /**
   * Extract context information from signal
   */
  private extractContext(signal: any): {
    environment: string;
    timestamp: string;
    source: string;
  } {
    return {
      environment: signal.environment || signal.cluster || signal.namespace || "unknown",
      timestamp: signal.timestamp || signal.event?.timestamp || new Date().toISOString(),
      source: signal.source || "unknown",
    };
  }

  /**
   * Calculate priority based on analysis
   */
  private calculatePriority(analysis: SignalAnalysis): number {
    let priority = analysis.urgency;

    // Adjust based on severity
    switch (analysis.severity) {
      case "critical":
        priority = Math.min(10, priority + 3);
        break;
      case "high":
        priority = Math.min(10, priority + 1);
        break;
      case "low":
        priority = Math.max(1, priority - 1);
        break;
    }

    return priority;
  }

  /**
   * Create default task for unknown patterns
   */
  private createDefaultTask(signal: any, analysis: SignalAnalysis): EnhancedTask {
    return {
      description: `Investigate ${analysis.domain} ${analysis.category}`,
      action: {
        type: analysis.actionType,
        target: {
          type: analysis.domain,
          identifier: analysis.category,
          metadata: analysis.extractedEntities,
        },
      },
      data: {
        issue: {
          type: analysis.category,
          description: `${analysis.category} detected in ${analysis.domain}`,
          details: analysis.extractedEntities,
        },
        context: {
          environment: "unknown",
          timestamp: new Date().toISOString(),
          source: signal.source || "unknown",
        },
      },
      priority: analysis.urgency,
      estimatedComplexity: "moderate",
      requiredCapabilities: [analysis.domain, analysis.actionType],
    };
  }
}