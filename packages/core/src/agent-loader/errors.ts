export class AgentNotFoundError extends Error {
  public readonly code = "AGENT_NOT_FOUND";

  constructor(agentId: string, adapterName: string) {
    super(`${adapterName}: Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}
