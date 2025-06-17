/**
 * Types for intelligent signal processing and task generation
 */

export interface SignalAnalysis {
  domain: string;           // "kubernetes", "web", "ci-cd", "security"
  category: string;         // "error", "warning", "deployment", "performance"
  severity: "critical" | "high" | "medium" | "low";
  actionType: "fix" | "investigate" | "monitor" | "optimize";
  urgency: number;          // 1-10 priority score
  extractedEntities: {     // Key information from signal
    // deno-lint-ignore no-explicit-any
    [key: string]: any;
  };
}

export interface SignalPattern {
  name: string;
  domain: string;
  triggers: SignalTrigger[];
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  actionType: "fix" | "investigate" | "monitor" | "optimize";
  urgency: number;
  entityExtraction?: EntityExtraction[];
}

export interface SignalTrigger {
  field: string;
  operator?: "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "matches";
  // deno-lint-ignore no-explicit-any
  value?: any;
  threshold?: number;
  regex?: string;
}

export interface EntityExtraction {
  name: string;
  field: string;
  transform?: string;
  required?: boolean;
}

export interface TaskTemplate {
  name: string;
  descriptionTemplate: string;  // "Fix {resource_type} {resource_name} in {namespace}"
  actionType: string;
  complexity: "simple" | "moderate" | "complex";
  requiredCapabilities: string[];
  dataExtraction: {
    requiredFields: string[];
    optionalFields: string[];
    transformations: Record<string, string>;
  };
}

export interface EnhancedTask {
  // Human-readable description
  description: string;
  
  // Machine-readable action
  action: {
    type: string;              // "diagnose", "fix", "scale", "investigate"
    target: {                  // What to act on
      type: string;
      identifier: string;
      metadata: Record<string, any>;
    };
  };
  
  // Clean, structured data
  data: {
    issue: {
      type: string;
      description: string;
      details: Record<string, any>;
    };
    context: {
      environment: string;
      timestamp: string;
      source: string;
    };
  };
  
  // Execution metadata
  priority: number;
  estimatedComplexity: "simple" | "moderate" | "complex";
  requiredCapabilities: string[];
}

export interface AgentCapabilities {
  domains: string[];           // ["kubernetes", "aws", "monitoring"]
  actions: string[];           // ["diagnose", "fix", "scale"]
  complexityLevels: string[];  // ["simple", "moderate", "complex"]
  resourceTypes: string[];     // ["pods", "deployments", "services"]
}

export interface SignalProcessingConfig {
  patterns: SignalPattern[];
  taskTemplates: TaskTemplate[];
  agentRouting: AgentRoutingRule[];
}

export interface AgentRoutingRule {
  capability: string;
  preferredAgents: string[];
  fallbackAgents: string[];
  conditions?: Record<string, any>;
}