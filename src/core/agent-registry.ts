import type { IWorkspaceAgent } from "../types/core.ts";

export interface AgentMetadata {
  id: string;
  type: string;
  config?: any;
  parentScopeId?: string;
}

type AgentFactory = (metadata: AgentMetadata) => Promise<IWorkspaceAgent>;

export class AgentRegistry {
  private static factories: Map<string, AgentFactory> = new Map();

  static registerAgent(type: string, factory: AgentFactory): void {
    this.factories.set(type, factory);
  }

  static async createAgent(metadata: AgentMetadata): Promise<IWorkspaceAgent> {
    const factory = this.factories.get(metadata.type);
    if (!factory) {
      throw new Error(`Unknown agent type: ${metadata.type}`);
    }
    return await factory(metadata);
  }

  static getRegisteredTypes(): string[] {
    return Array.from(this.factories.keys());
  }
}

// Register built-in agent types
AgentRegistry.registerAgent('echo', async (metadata) => {
  const { EchoAgent } = await import('../../examples/agents/echo-agent.ts');
  const agent = new EchoAgent(metadata.parentScopeId);
  (agent as any).id = metadata.id; // Restore ID
  return agent;
});

AgentRegistry.registerAgent('claude', async (metadata) => {
  const { ClaudeAgent } = await import('../../examples/agents/claude-agent.ts');
  const model = metadata.config?.model || 'claude-3-haiku-20240307';
  const agent = new ClaudeAgent(model, metadata.parentScopeId);
  (agent as any).id = metadata.id; // Restore ID
  return agent;
});

AgentRegistry.registerAgent('telephone', async (metadata) => {
  const { TelephoneAgent } = await import('../../examples/workspaces/telephone/telephone-agent.ts');
  const agentNumber = metadata.config?.agentNumber || 1;
  const agent = new TelephoneAgent(agentNumber, metadata.parentScopeId);
  (agent as any).id = metadata.id; // Restore ID
  return agent;
});

AgentRegistry.registerAgent('mishearing', async (metadata) => {
  const { MishearingAgent } = await import('../../examples/workspaces/telephone/agents/mishearing-agent.ts');
  const agent = new MishearingAgent(metadata.parentScopeId);
  (agent as any).id = metadata.id; // Restore ID
  return agent;
});

AgentRegistry.registerAgent('embellishment', async (metadata) => {
  const { EmbellishmentAgent } = await import('../../examples/workspaces/telephone/agents/embellishment-agent.ts');
  const agent = new EmbellishmentAgent(metadata.parentScopeId);
  (agent as any).id = metadata.id; // Restore ID
  return agent;
});

AgentRegistry.registerAgent('reinterpretation', async (metadata) => {
  const { ReinterpretationAgent } = await import('../../examples/workspaces/telephone/agents/reinterpretation-agent.ts');
  const agent = new ReinterpretationAgent(metadata.parentScopeId);
  (agent as any).id = metadata.id; // Restore ID
  return agent;
});