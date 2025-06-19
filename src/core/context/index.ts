/**
 * Atlas Context Management
 *
 * Provides context provisioning and hierarchical scoping for agents
 */

export { ContextProvisioner } from "./context-provisioner.ts";
export type {
  ContextProvisionerConfig,
  ProvisioningResult,
  SourceConfig,
} from "./context-provisioner.ts";

export { ContextScopeFactory } from "./context-scopes.ts";

export type {
  AccessLevel,
  AgentContextNeeds,
  APINeeds,
  CodebaseNeeds,
  ContextConstraints,
  ContextPolicy,
  ContextRequirement,
  DatabaseNeeds,
  DocumentationNeeds,
  IAgentContextScope,
  IContextScope,
  IJobContextScope,
  ISessionContextScope,
  IWorkspaceContextScope,
  PolicyAction,
  PolicyCondition,
  SourceDefinition,
} from "./context-scopes.ts";
