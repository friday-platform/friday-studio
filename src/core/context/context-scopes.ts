/**
 * Context Scoping Interfaces
 *
 * Defines hierarchical context access control following Atlas scoping pattern
 */

import type { ContextSpec } from "../emcp/emcp-provider.ts";

/**
 * Base context scope interface
 */
export interface IContextScope {
  readonly scopeType: "workspace" | "job" | "session" | "agent";
  readonly scopeId: string;
  readonly parentScopeId?: string;

  /**
   * Check if this scope can access a specific context type
   */
  canAccess(contextType: string): boolean;

  /**
   * Get allowed context specifications for this scope
   */
  getAllowedSpecs(contextType: string): ContextSpec[];

  /**
   * Filter context specifications based on scope permissions
   */
  filterSpecs(specs: ContextSpec[]): ContextSpec[];
}

/**
 * Workspace-level context scope (sees ALL)
 */
export interface IWorkspaceContextScope extends IContextScope {
  readonly scopeType: "workspace";

  /**
   * All available context sources in the workspace
   */
  readonly availableSources: Map<string, SourceDefinition>;

  /**
   * Global context policies
   */
  readonly policies: ContextPolicy[];
}

/**
 * Job-level context scope (scoped subset)
 */
export interface IJobContextScope extends IContextScope {
  readonly scopeType: "job";

  /**
   * Context requirements declared in job specification
   */
  readonly requirements: ContextRequirement[];

  /**
   * Inherited sources from workspace (filtered)
   */
  readonly allowedSources: string[];
}

/**
 * Session-level context scope (further filtered)
 */
export interface ISessionContextScope extends IContextScope {
  readonly scopeType: "session";

  /**
   * Runtime context data available to session
   */
  readonly runtimeContext: Map<string, unknown>;

  /**
   * Signal-specific context data
   */
  readonly signalContext?: unknown;
}

/**
 * Agent-level context scope (task-specific slice)
 */
export interface IAgentContextScope extends IContextScope {
  readonly scopeType: "agent";

  /**
   * Agent-declared context needs
   */
  readonly contextNeeds: AgentContextNeeds;

  /**
   * Task-specific context constraints
   */
  readonly taskConstraints: ContextConstraints;
}

/**
 * Source definition in workspace
 */
export interface SourceDefinition {
  readonly name: string;
  readonly provider: string;
  readonly config: Record<string, unknown>;
  readonly capabilities: string[]; // context types this source can provide
  readonly access: AccessLevel;
}

/**
 * Context access levels
 */
export type AccessLevel = "public" | "restricted" | "private";

/**
 * Context policy for governance
 */
export interface ContextPolicy {
  readonly name: string;
  readonly contextTypes: string[];
  readonly conditions: PolicyCondition[];
  readonly actions: PolicyAction[];
}

export interface PolicyCondition {
  readonly type: "scope" | "agent" | "time" | "size";
  readonly operator: "eq" | "ne" | "gt" | "lt" | "in" | "contains";
  readonly value: unknown;
}

export interface PolicyAction {
  readonly type: "allow" | "deny" | "filter" | "log";
  readonly parameters?: Record<string, unknown>;
}

/**
 * Job context requirements
 */
export interface ContextRequirement {
  readonly contextType: string;
  readonly required: boolean;
  readonly constraints: ContextConstraints;
  readonly sources?: string[]; // specific sources to use
}

/**
 * Context constraints
 */
export interface ContextConstraints {
  readonly maxSize?: string;
  readonly timeout?: number;
  readonly formats?: string[];
  readonly operations?: string[];
}

/**
 * Agent context needs declaration
 */
export interface AgentContextNeeds {
  readonly codebase?: CodebaseNeeds;
  readonly database?: DatabaseNeeds;
  readonly api?: APINeeds;
  readonly documentation?: DocumentationNeeds;
}

export interface CodebaseNeeds {
  readonly filePatterns?: string[];
  readonly focusAreas?: string[];
  readonly includeTests?: boolean;
  readonly language?: string;
  readonly maxSize?: string;
}

export interface DatabaseNeeds {
  readonly schema?: boolean;
  readonly sampleData?: number;
  readonly tables?: string[];
  readonly queries?: string[];
}

export interface APINeeds {
  readonly endpoints?: string[];
  readonly includeExamples?: boolean;
  readonly format?: "openapi" | "swagger" | "graphql";
}

export interface DocumentationNeeds {
  readonly sections?: string[];
  readonly includeCode?: boolean;
  readonly format?: "markdown" | "html" | "pdf";
}

/**
 * Context scope factory
 */
export class ContextScopeFactory {
  static createWorkspaceScope(
    workspaceId: string,
    sources: Map<string, SourceDefinition>,
    policies: ContextPolicy[] = [],
  ): IWorkspaceContextScope {
    return new WorkspaceContextScope(workspaceId, sources, policies);
  }

  static createJobScope(
    jobId: string,
    workspaceScope: IWorkspaceContextScope,
    requirements: ContextRequirement[],
  ): IJobContextScope {
    return new JobContextScope(jobId, workspaceScope.scopeId, requirements, workspaceScope);
  }

  static createSessionScope(
    sessionId: string,
    jobScope: IJobContextScope,
    signalContext?: unknown,
  ): ISessionContextScope {
    return new SessionContextScope(sessionId, jobScope.scopeId, jobScope, signalContext);
  }

  static createAgentScope(
    agentId: string,
    sessionScope: ISessionContextScope,
    contextNeeds: AgentContextNeeds,
    taskConstraints: ContextConstraints,
  ): IAgentContextScope {
    return new AgentContextScope(agentId, sessionScope.scopeId, contextNeeds, taskConstraints);
  }
}

// Implementation classes (basic implementations for Phase 1)

class WorkspaceContextScope implements IWorkspaceContextScope {
  readonly scopeType = "workspace" as const;

  constructor(
    public readonly scopeId: string,
    public readonly availableSources: Map<string, SourceDefinition>,
    public readonly policies: ContextPolicy[],
  ) {}

  canAccess(_contextType: string): boolean {
    // Workspace can access everything
    return true;
  }

  getAllowedSpecs(_contextType: string): ContextSpec[] {
    // Return all specs for now (Phase 1)
    return [];
  }

  filterSpecs(specs: ContextSpec[]): ContextSpec[] {
    // No filtering at workspace level
    return specs;
  }
}

class JobContextScope implements IJobContextScope {
  readonly scopeType = "job" as const;

  constructor(
    public readonly scopeId: string,
    public readonly parentScopeId: string,
    public readonly requirements: ContextRequirement[],
    private readonly workspaceScope: IWorkspaceContextScope,
  ) {}

  get allowedSources(): string[] {
    // Return sources that can fulfill job requirements
    const sources: string[] = [];
    for (const [sourceName, sourceDef] of this.workspaceScope.availableSources) {
      const hasRequiredCapability = this.requirements.some((req) =>
        sourceDef.capabilities.includes(req.contextType)
      );
      if (hasRequiredCapability) {
        sources.push(sourceName);
      }
    }
    return sources;
  }

  canAccess(contextType: string): boolean {
    return this.requirements.some((req) => req.contextType === contextType);
  }

  getAllowedSpecs(_contextType: string): ContextSpec[] {
    // Return specs matching job requirements (Phase 1)
    return [];
  }

  filterSpecs(specs: ContextSpec[]): ContextSpec[] {
    // Filter based on job requirements
    return specs.filter((spec) => this.canAccess(spec.type));
  }
}

class SessionContextScope implements ISessionContextScope {
  readonly scopeType = "session" as const;
  readonly runtimeContext = new Map<string, unknown>();

  constructor(
    public readonly scopeId: string,
    public readonly parentScopeId: string,
    private readonly jobScope: IJobContextScope,
    public readonly signalContext?: unknown,
  ) {}

  canAccess(contextType: string): boolean {
    return this.jobScope.canAccess(contextType);
  }

  getAllowedSpecs(contextType: string): ContextSpec[] {
    return this.jobScope.getAllowedSpecs(contextType);
  }

  filterSpecs(specs: ContextSpec[]): ContextSpec[] {
    return this.jobScope.filterSpecs(specs);
  }
}

class AgentContextScope implements IAgentContextScope {
  readonly scopeType = "agent" as const;

  constructor(
    public readonly scopeId: string,
    public readonly parentScopeId: string,
    public readonly contextNeeds: AgentContextNeeds,
    public readonly taskConstraints: ContextConstraints,
  ) {}

  canAccess(contextType: string): boolean {
    // Agent can only access what it declared it needs
    return contextType in this.contextNeeds;
  }

  getAllowedSpecs(_contextType: string): ContextSpec[] {
    // Return specs based on agent needs (Phase 1)
    return [];
  }

  filterSpecs(specs: ContextSpec[]): ContextSpec[] {
    // Filter based on agent context needs and task constraints
    return specs.filter((spec) => this.canAccess(spec.type));
  }
}
