/**
 * Testing helpers for Atlas components
 */

import type { WorkspaceSignalConfig } from "@atlas/config";
import { InMemoryStorageAdapter } from "@atlas/storage";
import { AtlasScope, type AtlasScopeOptions } from "../core/scope.ts";
import { Session, type SessionIntent } from "../core/session.ts";
import type {
  IAtlasGate,
  IAtlasScope,
  ITempestContext,
  ITempestContextManager,
  ITempestMemoryManager,
  ITempestMessage,
  ITempestMessageManager,
  IWorkspaceAgent,
  IWorkspaceSignal,
  IWorkspaceSignalCallback,
  IWorkspaceSource,
  IWorkspaceSupervisor,
  IWorkspaceWorkflow,
  MessageUser,
} from "../types/core.ts";

/**
 * Creates a Session instance with in-memory storage for testing
 */
export function createTestSession(
  workspaceId: string = "test-workspace",
  signals?: {
    triggers: IWorkspaceSignal[];
    callback: IWorkspaceSignalCallback | ((result: unknown) => Promise<void>);
  },
  agents?: IWorkspaceAgent[],
  workflows?: IWorkspaceWorkflow[],
  sources?: IWorkspaceSource[],
  intent?: SessionIntent,
): { session: Session; storage: InMemoryStorageAdapter } {
  const storage = new InMemoryStorageAdapter();

  // Create default signals if not provided
  const defaultSignals = signals || {
    triggers: [],
    callback: {
      onSuccess: () => {},
      onError: () => {},
      onComplete: () => {},
      execute: () => {},
      validate: () => true,
    },
  };

  const session = new Session(
    workspaceId,
    defaultSignals,
    agents,
    workflows,
    sources,
    intent,
    storage,
    false, // Disable cognitive loop for tests
  );

  return { session, storage };
}

/**
 * Creates an AtlasScope instance with in-memory storage for testing
 */
export function createTestScope(options?: Partial<AtlasScopeOptions>): {
  scope: AtlasScope;
  storage: InMemoryStorageAdapter;
} {
  const storage = new InMemoryStorageAdapter();

  const scope = new AtlasScope({
    ...options,
    storageAdapter: storage,
    enableCognitiveLoop: false, // Disable cognitive loop for tests
  });

  return { scope, storage };
}

/**
 * Mock context manager for testing
 */
export class MockContextManager implements ITempestContextManager {
  private contexts: ITempestContext[] = [];

  add(context: ITempestContext): void {
    this.contexts.push(context);
  }

  remove(context: ITempestContext): void {
    const index = this.contexts.indexOf(context);
    if (index > -1) {
      this.contexts.splice(index, 1);
    }
  }

  search(query: string): ITempestContext[] {
    return this.contexts.filter((ctx) =>
      JSON.stringify(ctx).toLowerCase().includes(query.toLowerCase()),
    );
  }

  size(): number {
    return this.contexts.length;
  }
}

/**
 * Mock memory manager for testing
 */
export class MockMemoryManager implements ITempestMemoryManager {
  private memory: Map<string, unknown> = new Map();

  remember(key: string, value: unknown): void {
    this.memory.set(key, value);
  }

  recall(key: string): unknown {
    return this.memory.get(key);
  }

  summarize(): string {
    return `Memory contains ${this.memory.size} items`;
  }

  size(): number {
    return this.memory.size;
  }
}

/**
 * Mock message manager for testing
 */
export class MockMessageManager implements ITempestMessageManager {
  history: ITempestMessage[] = [];

  newMessage(content: string, user: MessageUser): ITempestMessage {
    const message: ITempestMessage = {
      id: `msg-${Date.now()}`,
      message: content,
      promptUser: user,
      timestamp: new Date(),
    };
    this.history.push(message);
    return message;
  }

  editMessage(id: string, content: string): void {
    const message = this.history.find((m) => m.id === id);
    if (message) {
      message.message = content;
    }
  }

  getHistory(): ITempestMessage[] {
    return this.history;
  }
}

/**
 * Mock signal for testing
 */
export class MockSignal implements IWorkspaceSignal {
  public readonly id: string;
  public provider: { id: string; name: string };
  public context: ITempestContextManager;
  public memory: ITempestMemoryManager;
  public messages: ITempestMessageManager;
  public prompts: { system: string; user: string };
  public gates: IAtlasGate[] = [];
  public parentScopeId?: string;
  public supervisor?: IWorkspaceSupervisor;
  public workspaceId?: string;

  private triggerCount = 0;
  private lastTriggerTime?: Date;

  constructor(id: string = "mock-signal", providerName: string = "mock-provider") {
    this.id = id;
    this.provider = { id: `${providerName}-id`, name: providerName };
    this.prompts = { system: "Mock system prompt", user: "Mock user prompt" };
    this.context = new MockContextManager();
    this.memory = new MockMemoryManager();
    this.messages = new MockMessageManager();
  }

  async trigger(): Promise<void> {
    this.triggerCount++;
    this.lastTriggerTime = new Date();
    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  configure(_config: WorkspaceSignalConfig): void {
    // Store configuration if needed
  }

  getTriggerCount(): number {
    return this.triggerCount;
  }

  getLastTriggerTime(): Date | undefined {
    return this.lastTriggerTime;
  }

  // IAtlasScope methods
  newConversation(): ITempestMessageManager {
    this.messages = new MockMessageManager();
    return this.messages;
  }

  getConversation(): ITempestMessageManager {
    return this.messages;
  }

  archiveConversation(): void {}

  deleteConversation(): void {}
}

/**
 * Mock agent for testing
 */
export class MockAgent implements IWorkspaceAgent {
  public readonly id: string;
  public status: string = "ready";
  public host: string = "localhost";
  public context: ITempestContextManager;
  public memory: ITempestMemoryManager;
  public messages: ITempestMessageManager;
  public prompts: { system: string; user: string };
  public gates: IAtlasGate[] = [];
  public parentScopeId?: string;
  public supervisor?: IWorkspaceSupervisor;
  public workspaceId?: string;

  private invokeCount = 0;

  constructor(
    id: string = "mock-agent",
    private _name: string = "Mock Agent",
  ) {
    this.id = id;
    this.prompts = { system: "Mock agent system prompt", user: "Mock agent user prompt" };
    this.context = new MockContextManager();
    this.memory = new MockMemoryManager();
    this.messages = new MockMessageManager();
  }

  name(): string {
    return this._name;
  }

  nickname(): string {
    return this._name.toLowerCase().replace(/\s+/g, "-");
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "mock-provider";
  }

  purpose(): string {
    return "Mock agent for testing";
  }

  getAgentPrompts(): { system: string; user: string } {
    return this.prompts;
  }

  scope(): IAtlasScope {
    return this;
  }

  controls(): object {
    return {};
  }

  async invoke(message: string): Promise<string> {
    this.invokeCount++;
    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 10));
    return `Processed: ${message}`;
  }

  async *invokeStream(message: string): AsyncIterableIterator<string> {
    this.invokeCount++;
    // Simulate streaming response
    const words = message.split(" ");
    for (const word of words) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield `${word} `;
    }
  }

  getInvokeCount(): number {
    return this.invokeCount;
  }

  // IAtlasScope methods
  newConversation(): ITempestMessageManager {
    this.messages = new MockMessageManager();
    return this.messages;
  }

  getConversation(): ITempestMessageManager {
    return this.messages;
  }

  archiveConversation(): void {}

  deleteConversation(): void {}
}
