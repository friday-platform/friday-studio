/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { BaseWorker } from "./base-worker.ts";
import { SessionSupervisor, SessionContext, AgentResult } from "../session-supervisor.ts";

interface SessionConfig {
  sessionId: string;
  workspaceId?: string;
  signal?: any;
  payload?: any;
}

interface AgentWorkerInfo {
  worker: Worker;
  port: MessagePort;
  type: string;
}

class SessionSupervisorWorker extends BaseWorker {
  private supervisor: SessionSupervisor | null = null;
  private agents: Map<string, AgentWorkerInfo> = new Map();
  private sessionId: string | null = null;
  
  constructor() {
    super("session", "session");
  }
  
  protected async initialize(config: SessionConfig): Promise<void> {
    this.log("Initializing session supervisor:", config.sessionId);
    
    this.sessionId = config.sessionId;
    (this.context as any).sessionId = config.sessionId;
    
    // Create the SessionSupervisor (intelligent agent)
    this.supervisor = new SessionSupervisor(config.workspaceId);
    
    // Join session broadcast channel
    this.actor.send({ 
      type: 'JOIN_CHANNEL', 
      channel: `session-${config.sessionId}` 
    });
    
    this.log("Session supervisor initialized");
  }
  
  protected async processTask(taskId: string, data: any): Promise<any> {
    if (!this.supervisor) {
      throw new Error("Session supervisor not initialized");
    }

    switch (data.action) {
      case 'initialize': {
        // Receive session context from WorkspaceSupervisor
        const { intent, signal, payload, workspaceId, agents } = data;
        
        const sessionContext: SessionContext = {
          sessionId: this.sessionId!,
          workspaceId,
          signal,
          payload,
          availableAgents: agents,
          filteredMemory: [], // WorkspaceSupervisor would provide this
          constraints: intent?.constraints,
          additionalPrompts: data.additionalPrompts
        };
        
        await this.supervisor.initializeSession(sessionContext);
        
        this.log(`Session initialized with intent: ${intent?.id || 'none'}`);
        return { status: 'initialized', intentId: intent?.id };
      }
      
      case 'executeSession': {
        // Create execution plan using SessionSupervisor's intelligence
        const plan = await this.supervisor.createExecutionPlan();
        this.log(`Execution plan created with ${plan.phases.length} phases`);
        
        const results = [];
        
        // Execute each phase of the plan
        for (const phase of plan.phases) {
          this.log(`Executing phase: ${phase.name}`);
          
          const phaseResults = [];
          
          // Execute agents in the phase based on strategy
          if (phase.executionStrategy === 'sequential') {
            for (const agentTask of phase.agents) {
              const result = await this.executeAgentTask(agentTask, phaseResults);
              phaseResults.push(result);
              
              // Let supervisor evaluate progress
              const evaluation = await this.supervisor.evaluateProgress(phaseResults);
              if (evaluation.isComplete) {
                this.log("Session goal achieved early");
                break;
              }
            }
          } else {
            // Parallel execution
            const promises = phase.agents.map(agentTask => 
              this.executeAgentTask(agentTask, phaseResults)
            );
            const parallelResults = await Promise.all(promises);
            phaseResults.push(...parallelResults);
          }
          
          results.push({
            phaseId: phase.id,
            phaseName: phase.name,
            results: phaseResults
          });
          
          // Check if we should continue to next phase
          const evaluation = await this.supervisor.evaluateProgress(
            results.flatMap(r => r.results)
          );
          
          if (evaluation.isComplete) {
            break;
          } else if (evaluation.nextAction === 'adapt') {
            // Supervisor could adapt the plan here
            this.log("Adapting execution plan based on results");
          }
        }
        
        // Get final execution summary
        const summary = this.supervisor.getExecutionSummary();
        
        // Get LLM-generated session summary
        const sessionSummary = await this.supervisor.generateSessionSummary(results);
        
        // Log both diagnostic info and LLM summary
        this.log(`\n📊 Session Results Summary:`);
        this.log(`Session ID: ${this.sessionId}`);
        this.log(`Signal: ${this.supervisor.getSessionContext()?.signal.id}`);
        this.log(`Phases executed: ${results.length}`);
        this.log(`Total agents invoked: ${results.flatMap(r => r.results).length}`);
        this.log(`Status: ${summary.status}`);
        this.log(`\n🤖 AI Summary:\n${sessionSummary}`);
        
        return {
          status: summary.status,
          results,
          plan: summary.plan,
          evaluation: await this.supervisor.evaluateProgress(
            results.flatMap(r => r.results)
          ),
          summary: sessionSummary
        };
      }
      
      case 'spawnAgent': {
        const { agentType, agentId } = data;
        await this.spawnAgent(agentId, agentType);
        return { agentId, status: 'spawned' };
      }
      
      case 'invokeAgent': {
        const { agentId, input } = data;
        return await this.invokeAgent(agentId, input, taskId);
      }
      
      case 'getStatus': {
        const summary = this.supervisor?.getExecutionSummary();
        return {
          sessionId: this.sessionId,
          agentCount: this.agents.size,
          agents: Array.from(this.agents.entries()).map(([id, info]) => ({
            id,
            type: info.type
          })),
          executionStatus: summary?.status || 'unknown'
        };
      }
      
      default:
        throw new Error(`Unknown task action: ${data.action}`);
    }
  }
  
  protected async cleanup(): Promise<void> {
    this.log("Cleaning up session supervisor...");
    
    // Terminate all agent workers
    for (const [agentId, info] of this.agents) {
      info.worker.postMessage({ type: 'shutdown' });
      info.worker.terminate();
      info.port.close();
    }
    
    this.agents.clear();
    this.supervisor = null;
    this.sessionId = null;
  }
  
  private async spawnAgent(agentId: string, agentType: string): Promise<void> {
    this.log(`Spawning agent: ${agentType} (${agentId})`);
    
    // Create agent worker with permissions to use BroadcastChannel
    const agentWorker = new Worker(
      new URL("./agent-worker.ts", import.meta.url).href,
      { 
        type: "module",
        deno: {
          permissions: "inherit"
        }
      } as any
    );
    
    // Create message channel for direct communication
    const { port1, port2 } = new MessageChannel();
    
    // Store agent info
    this.agents.set(agentId, {
      worker: agentWorker,
      port: port1,
      type: agentType
    });
    
    // Setup worker message handling
    agentWorker.onmessage = (event) => {
      this.handleAgentMessage(agentId, event.data);
    };
    
    agentWorker.onerror = (error) => {
      this.log(`Agent ${agentId} error:`, error);
      self.postMessage({
        type: 'agentError',
        agentId,
        error: error.toString()
      });
    };
    
    // Initialize agent
    agentWorker.postMessage({
      type: 'init',
      id: agentId,
      workerType: 'agent',
      config: {
        agentId,
        agentType,
        sessionId: this.sessionId
      }
    });
    
    // Send port for direct communication
    agentWorker.postMessage({
      type: 'setPort',
      peerId: 'session',
      port: port2
    }, [port2]);
    
    // Setup port message handling
    port1.onmessage = (event) => {
      this.handleAgentDirectMessage(agentId, event.data);
    };
    
    // Notify that agent is spawned
    self.postMessage({
      type: 'agentSpawned',
      agentId,
      agentType
    });
  }
  
  private async executeAgentTask(agentTask: any, previousResults: any[]): Promise<AgentResult> {
    const { agentId, task, inputSource, dependencies } = agentTask;
    const startTime = Date.now();
    
    // Resolve input based on inputSource
    let input = this.supervisor.getSessionContext()?.payload;
    
    if (inputSource === 'previous' && previousResults.length > 0) {
      // Use the output from the last result
      input = previousResults[previousResults.length - 1].output;
    } else if (inputSource === 'combined') {
      // Combine multiple inputs
      input = {
        original: (this.context as any).payload,
        previous: previousResults.map(r => ({ agentId: r.agentId, output: r.output }))
      };
    } else if (dependencies && dependencies.length > 0) {
      // Use specific dependency output
      const lastDep = dependencies[dependencies.length - 1];
      const depResult = previousResults.find(r => r.agentId === lastDep);
      if (depResult) {
        input = depResult.output;
      }
    }
    
    // Spawn agent if not already spawned
    if (!this.agents.has(agentId)) {
      const agentType = this.getAgentType(agentId);
      await this.spawnAgent(agentId, agentType);
    }
    
    // Invoke the agent
    const output = await this.invokeAgent(agentId, input, crypto.randomUUID());
    
    return {
      agentId,
      task,
      input,
      output,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }
  
  private getAgentType(agentId: string): string {
    // Extract agent type from ID or use a mapping
    // For now, use simple heuristics
    if (agentId.includes('mishearing')) return 'mishearing';
    if (agentId.includes('embellishment')) return 'embellishment';
    if (agentId.includes('reinterpretation')) return 'reinterpretation';
    if (agentId.includes('telephone')) return 'telephone';
    if (agentId.includes('claude')) return 'claude';
    return 'echo'; // default
  }

  private async invokeAgent(agentId: string, input: any, taskId: string): Promise<any> {
    const agentInfo = this.agents.get(agentId);
    if (!agentInfo) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Agent ${agentId} invocation timeout`));
      }, 60000);
      
      // Listen for result
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'result' && event.data.taskId === taskId) {
          clearTimeout(timeout);
          agentInfo.worker.removeEventListener('message', handleMessage);
          resolve(event.data.result);
        } else if (event.data.type === 'error' && event.data.taskId === taskId) {
          clearTimeout(timeout);
          agentInfo.worker.removeEventListener('message', handleMessage);
          reject(new Error(event.data.error));
        }
      };
      
      agentInfo.worker.addEventListener('message', handleMessage);
      
      // Send task to agent
      agentInfo.worker.postMessage({
        type: 'task',
        taskId,
        data: {
          action: 'invoke',
          input
        }
      });
    });
  }
  
  private handleAgentMessage(agentId: string, message: any): void {
    switch (message.type) {
      case 'initialized':
        this.log(`Agent ${agentId} initialized`);
        break;
        
      case 'result':
      case 'error':
        // These are handled by the promise in invokeAgent
        break;
        
      default:
        this.log(`Agent ${agentId} message:`, message);
    }
  }
  
  private handleAgentDirectMessage(agentId: string, message: any): void {
    this.log(`Agent ${agentId} direct message:`, message);
    
    // Forward important messages to supervisor or handle coordination
    if (message.type === 'chunk') {
      // Forward streaming chunks
      self.postMessage({
        type: 'agentChunk',
        agentId,
        chunk: message.chunk
      });
    }
  }
  
  // Handle broadcast messages in the session
  protected override handleBroadcast(channel: string, data: any): void {
    switch (data.type) {
      case 'agentMessage':
        this.log(`Agent ${data.from} broadcast: ${data.message}`);
        
        // Forward to parent
        self.postMessage({
          type: 'sessionBroadcast',
          data
        });
        break;
        
      case 'supervisorCommand':
        this.log(`Supervisor command:`, data);
        // Handle supervisor coordination commands
        break;
        
      default:
        this.log(`Unknown broadcast type: ${data.type}`);
    }
  }
}

// Create and start the worker
new SessionSupervisorWorker();