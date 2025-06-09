/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { BaseWorker } from "./base-worker.ts";
import { AgentRegistry } from "../agent-registry.ts";
import type { IWorkspaceAgent } from "../../types/core.ts";

class AgentWorker extends BaseWorker {
  private agent: IWorkspaceAgent | null = null;
  private sessionId: string | null = null;
  private agentId: string | null = null;
  private agentType: string | null = null;
  
  constructor() {
    super("agent", "agent");
  }
  
  protected async initialize(config: any): Promise<void> {
    this.log("Initializing with config:", config);
    
    // Extract agent info
    const { agentId, agentType, sessionId } = config;
    this.agentId = agentId;
    this.agentType = agentType;
    this.sessionId = sessionId;
    
    // Create agent instance
    this.agent = await AgentRegistry.createAgent({
      id: agentId,
      type: agentType,
      parentScopeId: sessionId
    });
    
    if (!this.agent) {
      throw new Error(`Failed to create agent of type: ${agentType}`);
    }
    
    // Join session broadcast channel
    this.actor.send({ 
      type: 'JOIN_CHANNEL', 
      channel: `session-${sessionId}` 
    });
    
    this.log(`Agent ${agentId} (${agentType}) initialized`);
  }
  
  protected async processTask(taskId: string, data: any): Promise<any> {
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }
    
    switch (data.action) {
      case 'invoke': {
        const { input } = data;
        this.log(`Processing input:`, JSON.stringify(input));
        
        // Extract message from input if it's an object
        const message = typeof input === 'object' && input.message ? input.message : input;
        
        // Check if agent supports streaming
        if ('invokeStream' in this.agent && typeof this.agent.invokeStream === 'function') {
          let result = '';
          for await (const chunk of this.agent.invokeStream(message)) {
            result += chunk;
            
            // Send chunks to supervisor via direct message
            this.sendDirect('supervisor', {
              type: 'chunk',
              chunk,
              agentId: this.agentId,
              taskId
            });
          }
          
          // Broadcast completion to session
          this.broadcast(`session-${this.sessionId}`, {
            type: 'agentMessage',
            from: this.agentId,
            message: result,
            timestamp: new Date().toISOString()
          });
          
          return result;
          
        } else if ('invoke' in this.agent && typeof this.agent.invoke === 'function') {
          const result = await this.agent.invoke(message);
          
          // Broadcast to session
          this.broadcast(`session-${this.sessionId}`, {
            type: 'agentMessage',
            from: this.agentId,
            message: result,
            timestamp: new Date().toISOString()
          });
          
          return result;
        } else {
          throw new Error('Agent does not support invoke or invokeStream');
        }
      }
      
      case 'query': {
        // Respond to queries about agent state
        return {
          agentId: this.agentId,
          agentType: this.agentType,
          controls: this.agent.controls() || {}
        };
      }
      
      default:
        throw new Error(`Unknown task action: ${data.action}`);
    }
  }
  
  protected async cleanup(): Promise<void> {
    this.log("Cleaning up agent...");
    this.agent = null;
    this.sessionId = null;
    this.agentId = null;
    this.agentType = null;
  }
  
  // Handle direct messages from supervisor
  protected override handleDirectMessage(peerId: string, data: any): void {
    this.log(`Direct message from ${peerId}:`, data);
    
    if (peerId === 'supervisor') {
      switch (data.type) {
        case 'updateContext':
          // Update agent context if needed
          if (this.agent && data.context) {
            // Agent context updates would go here
            this.log("Context update received from supervisor");
          }
          break;
          
        default:
          this.log(`Unknown supervisor message type: ${data.type}`);
      }
    }
  }
  
  // Handle broadcast messages from other agents in session
  protected override handleBroadcast(channel: string, data: any): void {
    if (data.type === 'agentMessage' && data.from !== this.agentId) {
      this.log(`Agent ${data.from} sent: ${data.message}`);
      // Could track other agent messages in conversation context
    }
  }
}

// Create and start the worker
new AgentWorker();