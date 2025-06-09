// Core Atlas interfaces based on technical design document

export interface IAtlasScope {
  id: string;
  parentScopeId?: string;
  supervisor?: IWorkspaceSupervisor;
  context: ITempestContextManager;
  memory: ITempestMemoryManager;
  messages: ITempestMessageManager;
  prompts: {
    system: string;
    user: string;
  };
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
  execute(): Promise<void>;
  validate(): boolean;
}

export interface IAtlasGate extends IAtlasDecisionGraph {
  // Policy constraints for agents
  evaluate(input: any): Promise<boolean>;
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
  addWorkflow(workflow: IWorkspaceWorkflow): Error | null;
  addSource(source: IWorkspaceSource): Error | null;
  addAction(action: IWorkspaceAction): Error | null;
  // Note: Runtime concerns removed - these belong in WorkspaceRuntime:
  // currentActiveSessions() - moved to runtime
  // getAllArtifacts() - moved to runtime
  snapshot(): object;
}

export interface IWorkspaceArtifact {
  id: string;
  type: string;
  data: any;
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
  spawnSession(
    signal: IWorkspaceSignal,
    payload?: any,
  ): Promise<IWorkspaceSession>;
  manageAgentLifecycle(): void;
  processSignalInterrupts(): void;
}

export interface IWorkspaceSession extends IAtlasScope {
  signals: {
    triggers: IWorkspaceSignal[];
    callback: IWorkspaceSignalCallback;
  };
  agents?: IWorkspaceAgent[];
  workflows?: IWorkspaceWorkflow[];
  sources?: IWorkspaceSource[];
  status: string; // 'pending' | 'running' | 'completed' | 'cancelled'
  start(): Promise<void>;
  cancel(): Promise<void>;
  progress(): number;
  summarize(): string;
  getArtifacts(): IWorkspaceArtifact[];
}

export interface IWorkspaceSessionPlan extends IAtlasDecisionGraph {
  steps: any[];
  dependencies: string[];
}

export interface IWorkspaceSignal extends IAtlasScope {
  provider: {
    id: string;
    name: string;
  };
  trigger(): Promise<void>;
  configure(config: any): void;
}

export interface IWorkspaceSignalCallback extends IAtlasDecisionGraph {
  onSuccess(result: any): void;
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
}

export enum WorkspaceMemberRole {
  OWNER = "owner",
  WATCHER = "watcher",
}

export interface IWorkspaceWorkflow {
  id: string;
  name: string;
  steps: any[];
  execute(): Promise<any>;
}

export interface IWorkspaceSource {
  id: string;
  type: string;
  data: any;
}

export interface IWorkspaceAction {
  id: string;
  name: string;
  execute(): Promise<any>;
}

// Context and Memory Management
export interface ITempestContextManager {
  add(context: ITempestContext): void;
  remove(context: ITempestContext): void;
  search(query: string): ITempestContext[];
  size(): number;
}

export interface ITempestContext {
  source: {
    type: string;
    id: string;
  };
  detail: string;
}

export interface ITempestMemoryManager {
  remember(key: string, value: any): void;
  recall(key: string): any;
  summarize(): string;
  size(): number;
  forget(key: string): void;
}

export interface ITempestMemoryStorageAdapter {
  commit(data: any): Promise<void>;
  load(): Promise<any>;
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
