// Core Atlas interfaces for atlasd daemon internals
// Migrated from src/types/core.ts — these 19 exports are consumed exclusively by daemon code.

import type { WorkspaceSignalConfig } from "@atlas/config";
import type { WorkspaceSessionStatusType } from "@atlas/core";
import type { MaybePromise } from "@atlas/utils";

/**
 * Summary of session execution state.
 *
 * Returned from FSM execution to track phase counts and overall status.
 * Used by waitForCompletion() to signal session termination.
 */
export interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  status: WorkspaceSessionStatusType;
  totalPhases: number;
  completedPhases: number;
  duration: number;
  reasoning: string;
}

export interface IAtlasScope {
  id: string;
  workspaceId?: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  context: ITempestContextManager;
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

export interface IWorkspaceArtifact {
  id: string;
  type: string;
  data: unknown;
  createdAt: Date;
  createdBy: string;
}

export interface IWorkspaceSupervisor extends IAtlasScope, IWorkspaceAgent {
  config?: { defaultModel?: string; [key: string]: unknown };
  spawnSession(signal: IWorkspaceSignal, payload?: unknown): Promise<IWorkspaceSession>;
  manageAgentLifecycle(): void;
  processSignalInterrupts(): void;
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
  SYSTEM = "system",
}

// Defined here, re-exported from @atlas/core (via packages/core/src/types/legacy.ts)
// for use by packages outside atlasd.

export interface IWorkspaceSession extends IAtlasScope {
  signals: { triggers: IWorkspaceSignal[]; callback: IWorkspaceSignalCallback };
  agents?: IWorkspaceAgent[];
  workflows?: IWorkspaceWorkflow[];
  sources?: IWorkspaceSource[];
  status: WorkspaceSessionStatusType;
  error?: string;
  start(): MaybePromise<void>;
  cancel(): void;
  cleanup(): void;
  progress(): number;
  summarize(): string;
  getArtifacts(): IWorkspaceArtifact[];
  waitForCompletion(): Promise<SessionSummary>;
}

export interface IWorkspaceSignal extends IAtlasScope {
  provider: { id: string; name: string };
  trigger(): Promise<void>;
  configure(config: WorkspaceSignalConfig): void;
}
