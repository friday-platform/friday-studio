import type {
  IAtlasGate,
  IAtlasScope,
  ITempestContext,
  ITempestContextManager,
  ITempestMemoryManager,
  ITempestMessage,
  ITempestMessageManager,
  IWorkspace,
  IWorkspaceAction,
  IWorkspaceAgent,
  IWorkspaceSignal,
  IWorkspaceSource,
  IWorkspaceSupervisor,
  IWorkspaceWorkflow,
  MessageUser,
} from "../../src/types/core.ts";
import { WorkspaceMemberRole } from "../../src/types/core.ts";
import { ContextManager } from "../../src/core/context.ts";
import { MemoryManager } from "../../src/core/memory.ts";
import { MessageManager } from "../../src/core/messages.ts";

// Mock implementations
class MockContextManager implements ITempestContextManager {
  private contexts: ITempestContext[] = [];

  add(context: ITempestContext): void {
    this.contexts.push(context);
  }

  remove(context: ITempestContext): void {
    this.contexts = this.contexts.filter((c) => c !== context);
  }

  search(query: string): ITempestContext[] {
    return this.contexts.filter((c) => c.detail.includes(query) || c.source.id.includes(query));
  }

  size(): number {
    return this.contexts.length;
  }
}

class MockMemoryManager implements ITempestMemoryManager {
  private store = new Map<string, any>();

  remember(key: string, value: any): void {
    this.store.set(key, value);
  }

  recall(key: string): any {
    return this.store.get(key);
  }

  summarize(): string {
    return `Memory contains ${this.store.size} items`;
  }

  size(): number {
    return this.store.size;
  }

  forget(key: string): void {
    this.store.delete(key);
  }
}

class MockMessageManager implements ITempestMessageManager {
  history: ITempestMessage[] = [];

  newMessage(content: string, user: MessageUser): ITempestMessage {
    const message: ITempestMessage = {
      id: crypto.randomUUID(),
      promptUser: user,
      message: content,
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

  deleteMessage(id: string): void {
    this.history = this.history.filter((m) => m.id !== id);
  }

  getHistory(): ITempestMessage[] {
    return [...this.history];
  }
}

// Factory function to create a mock signal with all required properties
export function createMockSignal(
  id: string = "test-signal",
  providerId: string = "test-provider",
  providerName: string = "Test Provider",
): IWorkspaceSignal {
  const signal: IWorkspaceSignal = {
    id: id,
    parentScopeId: undefined,
    supervisor: undefined,
    context: new MockContextManager(),
    memory: new MockMemoryManager(),
    messages: new MockMessageManager(),
    prompts: {
      system: "You are a test signal",
      user: "Process this test signal",
    },
    gates: [],
    provider: {
      id: providerId,
      name: providerName,
    },

    // IAtlasScope methods
    newConversation(): ITempestMessageManager {
      return new MockMessageManager();
    },

    getConversation(): ITempestMessageManager {
      return this.messages;
    },

    archiveConversation(): void {
      // Mock implementation
      console.log("Conversation archived");
    },

    deleteConversation(): void {
      this.messages = new MockMessageManager();
    },

    // IWorkspaceSignal methods
    async trigger(): Promise<void> {
      console.log(`Signal ${id} triggered`);
    },

    configure(config: any): void {
      console.log(`Signal ${id} configured with:`, config);
    },
  };

  return signal;
}

// Factory function to create a mock workspace configuration
export function createMockWorkspaceConfig(overrides?: Partial<any>) {
  return {
    id: "test-workspace",
    name: "Test Workspace",
    agents: {},
    signals: {},
    workflows: {},
    sources: {},
    actions: {},
    ...overrides,
  };
}

// Factory function to create mock agent metadata
export function createMockAgentMetadata(
  id: string = "test-agent",
  name: string = "Test Agent",
) {
  return {
    id,
    name,
    version: "1.0.0",
    provider: "test",
    purpose: "Testing",
    status: "ready",
    host: "test-host",
  };
}

// Factory function to create a mock workspace
export function createMockWorkspace(
  id: string = "test-workspace",
  name: string = "Test Workspace",
): IWorkspace {
  const workspace: IWorkspace = {
    // IAtlasScope properties
    id,
    parentScopeId: undefined,
    supervisor: undefined,
    context: new MockContextManager(),
    memory: new MockMemoryManager(),
    messages: new MockMessageManager(),
    prompts: {
      system: "You are a test workspace",
      user: "Process workspace operations",
    },
    gates: [],

    // IWorkspace properties
    members: {
      id: "test-owner",
      name: "Test Owner",
      role: WorkspaceMemberRole.OWNER,
    },
    signals: {},
    agents: {},
    workflows: {},
    sources: {},
    actions: {},

    // IAtlasScope methods
    newConversation(): ITempestMessageManager {
      return new MockMessageManager();
    },

    getConversation(): ITempestMessageManager {
      return this.messages;
    },

    archiveConversation(): void {
      console.log("Workspace conversation archived");
    },

    deleteConversation(): void {
      this.messages = new MockMessageManager();
    },

    // IWorkspace methods
    addSignal(signal: IWorkspaceSignal): Error | null {
      if (this.signals[signal.id]) {
        return new Error(`Signal ${signal.id} already exists`);
      }
      this.signals[signal.id] = signal;
      return null;
    },

    addAgent(agent: IWorkspaceAgent): Error | null {
      if (this.agents[agent.id]) {
        return new Error(`Agent ${agent.id} already exists`);
      }
      this.agents[agent.id] = agent;
      return null;
    },

    removeAgent(agentId: string): Error | null {
      if (!this.agents[agentId]) {
        return new Error(`Agent ${agentId} not found`);
      }
      delete this.agents[agentId];
      return null;
    },

    addWorkflow(workflow: IWorkspaceWorkflow): Error | null {
      if (this.workflows[workflow.id]) {
        return new Error(`Workflow ${workflow.id} already exists`);
      }
      this.workflows[workflow.id] = workflow;
      return null;
    },

    addSource(source: IWorkspaceSource): Error | null {
      if (this.sources[source.id]) {
        return new Error(`Source ${source.id} already exists`);
      }
      this.sources[source.id] = source;
      return null;
    },

    addAction(action: IWorkspaceAction): Error | null {
      if (this.actions[action.id]) {
        return new Error(`Action ${action.id} already exists`);
      }
      this.actions[action.id] = action;
      return null;
    },

    // IWorkspace specific method
    snapshot(): object {
      return {
        id,
        name,
        description: `${name} snapshot`,
        agents: Object.keys(this.agents).length,
        signals: Object.keys(this.signals).length,
        workflows: Object.keys(this.workflows).length,
        sources: Object.keys(this.sources).length,
        actions: Object.keys(this.actions).length,
        members: this.members,
        timestamp: new Date().toISOString(),
      };
    },
  };

  return workspace;
}

// Factory function to create a mock agent
export function createMockAgent(
  id: string = "test-agent",
  name: string = "Test Agent",
): IWorkspaceAgent {
  const agent: IWorkspaceAgent = {
    // IAtlasScope properties
    id,
    parentScopeId: undefined,
    supervisor: undefined,
    context: new MockContextManager(),
    memory: new MockMemoryManager(),
    messages: new MockMessageManager(),
    prompts: {
      system: "You are a test agent",
      user: "Process agent tasks",
    },
    gates: [],

    // IWorkspaceAgent properties
    status: "ready",
    host: "test-host",

    // IAtlasScope methods
    newConversation(): ITempestMessageManager {
      return new MockMessageManager();
    },

    getConversation(): ITempestMessageManager {
      return this.messages;
    },

    archiveConversation(): void {
      console.log("Agent conversation archived");
    },

    deleteConversation(): void {
      this.messages = new MockMessageManager();
    },

    // IAtlasAgent methods
    name(): string {
      return name;
    },

    nickname(): string {
      return name.toLowerCase().replace(/\s+/g, "-");
    },

    version(): string {
      return "1.0.0";
    },

    provider(): string {
      return "test";
    },

    purpose(): string {
      return "Testing";
    },

    getAgentPrompts(): { system: string; user: string } {
      return this.prompts;
    },

    scope(): IAtlasScope {
      return this;
    },

    controls(): object {
      return {};
    },

    // IWorkspaceAgent methods
    async invoke(message: string): Promise<string> {
      return `Mock response to: ${message}`;
    },

    async *invokeStream(message: string): AsyncIterableIterator<string> {
      yield `Mock streaming response to: ${message}`;
    },
  };

  return agent;
}

// Factory function to create a mock workflow
export function createMockWorkflow(
  id: string = "test-workflow",
  name: string = "Test Workflow",
): IWorkspaceWorkflow {
  return {
    id,
    name,
    steps: [],
    async execute(): Promise<any> {
      return { success: true, message: "Mock workflow executed" };
    },
  };
}

// Factory function to create a mock source
export function createMockSource(
  id: string = "test-source",
  type: string = "test",
): IWorkspaceSource {
  return {
    id,
    type,
    data: { test: true },
  };
}

// Factory function to create a mock action
export function createMockAction(
  id: string = "test-action",
  name: string = "Test Action",
): IWorkspaceAction {
  return {
    id,
    name,
    async execute(): Promise<any> {
      return { success: true, message: "Mock action executed" };
    },
  };
}

// Export individual mock classes for direct use if needed
export { MockContextManager, MockMemoryManager, MockMessageManager };
