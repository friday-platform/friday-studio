/**
 * Testing helpers for Atlas components
 */

import { Session, type SessionIntent } from "../core/session.ts";
import type {
  IWorkspaceAgent,
  IWorkspaceSignal,
  IWorkspaceSignalCallback,
  IWorkspaceSource,
  IWorkspaceWorkflow,
} from "../types/core.ts";
import { InMemoryStorageAdapter } from "../storage/in-memory.ts";
import { AtlasScope, type AtlasScopeOptions } from "../core/scope.ts";

/**
 * Creates a Session instance with in-memory storage for testing
 */
export function createTestSession(
  workspaceId: string = "test-workspace",
  signals?: {
    triggers: IWorkspaceSignal[];
    callback: IWorkspaceSignalCallback | ((result: any) => Promise<void>);
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
    } as IWorkspaceSignalCallback,
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
export function createTestScope(
  options?: Partial<AtlasScopeOptions>,
): { scope: AtlasScope; storage: InMemoryStorageAdapter } {
  const storage = new InMemoryStorageAdapter();

  const scope = new AtlasScope({
    ...options,
    storageAdapter: storage,
    enableCognitiveLoop: false, // Disable cognitive loop for tests
  });

  return { scope, storage };
}

/**
 * Mock signal for testing
 */
export class MockSignal implements IWorkspaceSignal {
  public readonly id: string;
  public provider: {
    id: string;
    name: string;
  };
  public context: any;
  public memory: any;
  public messages: any;
  public prompts: { system: string; user: string };
  public gates: any[] = [];
  public parentScopeId?: string;
  public supervisor?: any;

  private triggerCount = 0;
  private lastTriggerTime?: Date;

  constructor(
    id: string = "mock-signal",
    providerName: string = "mock-provider",
  ) {
    this.id = id;
    this.provider = {
      id: `${providerName}-id`,
      name: providerName,
    };
    this.prompts = {
      system: "Mock system prompt",
      user: "Mock user prompt",
    };
  }

  async trigger(): Promise<void> {
    this.triggerCount++;
    this.lastTriggerTime = new Date();
    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  configure(config: any): void {
    // Store configuration if needed
  }

  getTriggerCount(): number {
    return this.triggerCount;
  }

  getLastTriggerTime(): Date | undefined {
    return this.lastTriggerTime;
  }

  // IAtlasScope methods
  newConversation(): any {
    return {};
  }

  getConversation(): any {
    return {};
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
  public context: any;
  public memory: any;
  public messages: any;
  public prompts: { system: string; user: string };
  public gates: any[] = [];
  public parentScopeId?: string;
  public supervisor?: any;

  private invokeCount = 0;

  constructor(
    id: string = "mock-agent",
    private _name: string = "Mock Agent",
  ) {
    this.id = id;
    this.prompts = {
      system: "Mock agent system prompt",
      user: "Mock agent user prompt",
    };
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

  scope(): any {
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
  newConversation(): any {
    return {};
  }

  getConversation(): any {
    return {};
  }

  archiveConversation(): void {}

  deleteConversation(): void {}
}
