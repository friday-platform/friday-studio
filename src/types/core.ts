// Core Atlas interfaces based on technical design document

import type { AgentResult } from "@atlas/agent-sdk";
import type { WorkspaceSignalConfig } from "@atlas/config";
import type { AgentOrchestrator } from "@atlas/core";
import type { CoALAMemoryEntry, CoALAMemoryType } from "@atlas/memory";
import type { MaybePromise } from "@atlas/utils";

/**
 * Summary of session execution state for supervisor coordination.
 *
 * Returned from FSM execution to track phase/agent counts and overall
 * status. Used by the supervisor to coordinate multi-step execution
 * and determine when a session is complete.
 *
 * @remarks
 * This is distinct from {@link SessionDigest} (packages/core/src/session/build-session-digest.ts)
 * which captures full I/O content for agent analysis. SessionSummary focuses
 * on orchestration metrics; SessionDigest focuses on actual data.
 *
 * Use SessionSummary when: supervisor needs execution progress/state
 * Use SessionDigest when: agent needs to understand what happened
 */
export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  status: string;
  totalPhases: number;
  totalAgents: number;
  completedPhases: number;
  executedAgents: number;
  duration: number;
  reasoning: string;
  results: AgentResult[];
}

export interface IAtlasScope {
  id: string;
  workspaceId?: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  context: ITempestContextManager;
  memory: ITempestMemoryManager;
  messages: ITempestMessageManager;
  prompts: { system: string; user: string };
  gates: IAtlasGate[];
  newConversation(): ITempestMessageManager;
  getConversation(): ITempestMessageManager;
  archiveConversation(): void;
  deleteConversation(): void;
}

export interface IAtlasAgent extends IAtlasScope {
  name(): string;
  nickname(): string;
  version(): string;
  provider(): string;
  purpose(): string;
  getAgentPrompts(): { system: string; user: string };
  scope(): IAtlasScope;
  controls(): object;
}

export interface IAtlasDecisionGraph {
  // Agentic Behavior Trees implementation
  execute(): void;
  validate(): boolean;
}

export interface IAtlasGate extends IAtlasDecisionGraph {
  // Policy constraints for agents
  evaluate(input: unknown): Promise<boolean>;
  reject(reason: string): void;
}

export interface IWorkspace extends IAtlasScope {
  members: IWorkspaceMember;
  messages: ITempestMessageManager;
  signals: Record<string, IWorkspaceSignal>;
  agents: Record<string, IWorkspaceAgent>;
  workflows: Record<string, IWorkspaceWorkflow>;
  sources: Record<string, IWorkspaceSource>;
  actions: Record<string, IWorkspaceAction>;
  // Private properties handled in implementation
  addSignal(signal: IWorkspaceSignal): Error | null;
  addAgent(agent: IWorkspaceAgent): Error | null;
  removeAgent(agentId: string): Error | null;
  addWorkflow(workflow: IWorkspaceWorkflow): Error | null;
  addSource(source: IWorkspaceSource): Error | null;
  addAction(action: IWorkspaceAction): Error | null;
  // Note: Runtime concerns removed - these belong in WorkspaceRuntime:
  // currentActiveSessions() - moved to runtime
  // getAllArtifacts() - moved to runtime
  snapshot(): object;
  // Agent orchestrator access (implemented in WorkspaceRuntime)
  getAgentOrchestrator?(): AgentOrchestrator | undefined;
}

export interface IWorkspaceArtifact {
  id: string;
  type: string;
  data: unknown;
  createdAt: Date;
  createdBy: string;
}

export interface IWorkspaceDocument {
  id: string;
  title: string;
  content: string;
  artifacts: IWorkspaceArtifact[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IWorkspaceLibrary {
  documents: IWorkspaceDocument[];
  artifacts: IWorkspaceArtifact[];
  search(query: string): (IWorkspaceDocument | IWorkspaceArtifact)[];
  add(item: IWorkspaceDocument | IWorkspaceArtifact): void;
}

export interface IWorkspaceSupervisor extends IAtlasScope, IWorkspaceAgent {
  config?: { defaultModel?: string; [key: string]: unknown };
  spawnSession(signal: IWorkspaceSignal, payload?: unknown): Promise<IWorkspaceSession>;
  manageAgentLifecycle(): void;
  processSignalInterrupts(): void;
}

export interface IWorkspaceSession extends IAtlasScope {
  signals: { triggers: IWorkspaceSignal[]; callback: IWorkspaceSignalCallback };
  agents?: IWorkspaceAgent[];
  workflows?: IWorkspaceWorkflow[];
  sources?: IWorkspaceSource[];
  status: string; // 'pending' | 'running' | 'completed' | 'cancelled'
  start(): MaybePromise<void>;
  cancel(): void;
  cleanup(): void;
  progress(): number;
  summarize(): string;
  getArtifacts(): IWorkspaceArtifact[];
  waitForCompletion(): Promise<SessionSummary>;
}

export interface IWorkspaceSessionPlan extends IAtlasDecisionGraph {
  steps: unknown[];
  dependencies: string[];
}

export interface IWorkspaceSignal extends IAtlasScope {
  provider: { id: string; name: string };
  trigger(): Promise<void>;
  configure(config: WorkspaceSignalConfig): void;
}

export interface IWorkspaceSignalCallback extends IAtlasDecisionGraph {
  onSuccess(result: Record<string, unknown>): void;
  onError(error: Error): void;
  onComplete(): void;
}

export interface IWorkspaceAgent extends IAtlasAgent {
  status: string;
  host: string;
  invoke(message: string): Promise<string>;
  invokeStream(message: string): AsyncIterableIterator<string>;
}

export interface IWorkspaceMember {
  id: string;
  name: string;
  role: WorkspaceMemberRole;
  /** User ID who created this workspace, used for analytics */
  userId?: string;
}

export enum WorkspaceMemberRole {
  OWNER = "owner",
}

export interface IWorkspaceWorkflow {
  id: string;
  name: string;
  steps: unknown[];
  execute(): Promise<unknown>;
}

export interface IWorkspaceSource {
  id: string;
  type: string;
  data: unknown;
}

export interface IWorkspaceAction {
  id: string;
  name: string;
  execute(): Promise<unknown>;
}

// Context and Memory Management
export interface ITempestContextManager {
  add(context: ITempestContext): void;
  remove(context: ITempestContext): void;
  search(query: string): ITempestContext[];
  size(): number;
}

export interface ITempestContext {
  source: { type: string; id: string };
  detail: string;
}

// Enhanced memory interface supporting both legacy and CoALA methods
export interface ITempestMemoryManager {
  // CoALA-specific methods (optional for backwards compatibility)
  rememberWithMetadata?(
    key: string,
    content: string | Record<string, string>,
    metadata: {
      memoryType: CoALAMemoryType;
      tags: string[];
      relevanceScore: number;
      associations?: string[];
      confidence?: number;
      decayRate?: number;
      source?: string;
      sourceMetadata?: {
        agentId?: string;
        toolName?: string;
        sessionId?: string;
        userId?: string;
        workspaceId?: string;
      };
    },
  ): void;

  queryMemories?(query: {
    content?: string;
    memoryType?: string;
    tags?: string[];
    minRelevance?: number;
    maxAge?: number;
    sourceScope?: string;
    limit?: number;
  }): unknown[];

  // Cognitive loop methods
  reflect?(): unknown[];
  consolidate?(): void;
  prune?(): void;
  adapt?(feedback: unknown): void;
}

// Enhanced storage adapter for CoALA memory types
export interface ICoALAMemoryStorageAdapter {
  commitByType(memoryType: CoALAMemoryType, data: CoALAMemoryEntry[]): Promise<void>;
  loadByType(memoryType: CoALAMemoryType): Promise<CoALAMemoryEntry[]>;
  commitAll(dataByType: Record<CoALAMemoryType, CoALAMemoryEntry[]>): Promise<void>;
  loadAll(): Promise<Record<CoALAMemoryType, CoALAMemoryEntry[]>>;
  listMemoryTypes(): CoALAMemoryType[];
}

export interface ITempestMessageManager {
  history: ITempestMessage[];
  newMessage(content: string, user: MessageUser): ITempestMessage;
  editMessage(id: string, content: string): void;
  getHistory(): ITempestMessage[];
}

export interface ITempestMessage {
  id: string;
  promptUser: MessageUser;
  message: string;
  timestamp: Date;
}

export enum MessageUser {
  HUMAN = "human",
  AGENT = "agent",
  SYSTEM = "system",
}
