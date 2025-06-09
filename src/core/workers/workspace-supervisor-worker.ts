/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />

import { BaseWorker } from "./base-worker.ts";
import { WorkspaceSupervisor } from "../supervisor.ts";
import type { IWorkspace } from "../../types/core.ts";

interface SessionWorkerInfo {
  worker: Worker;
  port: MessagePort;
  sessionId: string;
}

class WorkspaceSupervisorWorker extends BaseWorker {
  private supervisor: WorkspaceSupervisor | null = null;
  private workspace: IWorkspace | null = null;
  private sessions: Map<string, SessionWorkerInfo> = new Map();
  
  constructor() {
    super("supervisor", "supervisor");
  }
  
  protected async initialize(config: any): Promise<void> {
    this.log("Initializing with config:", config);
    
    // Create supervisor
    const workspaceId = config.id || config.workspace?.id || "default";
    this.supervisor = new WorkspaceSupervisor(workspaceId, config.config || {});
    
    // If workspace info provided, store it
    if (config.workspace) {
      this.workspace = config.workspace;
      this.supervisor.setWorkspace(this.workspace);
    }
    
    this.log("Supervisor initialized");
  }
  
  protected async processTask(taskId: string, data: any): Promise<any> {
    if (!this.supervisor) {
      throw new Error("Supervisor not initialized");
    }
    
    switch (data.action) {
      case 'processSignal': {
        const { signal, payload, sessionId } = data;
        
        // Spawn session worker
        const sessionWorker = await this.spawnSessionWorker(sessionId);
        
        // Join the session's broadcast channel
        this.actor.send({ 
          type: 'JOIN_CHANNEL', 
          channel: `session-${sessionId}` 
        });
        
        // Use WorkspaceSupervisor's intelligence to analyze the signal
        this.log("Analyzing signal with WorkspaceSupervisor...");
        const analyzeStart = Date.now();
        const intent = await this.supervisor.analyzeSignal(signal, payload);
        const analyzeTime = Date.now() - analyzeStart;
        this.log(`Signal analysis complete (took ${analyzeTime}ms)`);
        
        // Create filtered context for this specific session
        this.log("Creating session context...");
        const contextStart = Date.now();
        const sessionContext = await this.supervisor.createSessionContext(intent, signal, payload);
        const contextTime = Date.now() - contextStart;
        this.log(`Session context created (took ${contextTime}ms)`);
        
        // Send filtered initialization data to session worker
        this.log(`Sending initialization to session worker ${sessionId}...`);
        const initTaskId = crypto.randomUUID();
        await this.sendToSessionWorker(sessionId, {
          type: 'task',
          taskId: initTaskId,
          data: {
            action: 'initialize',
            intent,
            signal,
            payload,
            workspaceId: this.workspace?.id,
            agents: sessionContext.availableAgents || [],
            filteredMemory: sessionContext.filteredMemory || [],
            constraints: sessionContext.constraints,
            additionalPrompts: sessionContext.additionalPrompts
          }
        });
        this.log(`Initialization sent to session worker`);
        
        // Start session execution in worker (SessionSupervisor will create the plan)
        const executionTaskId = crypto.randomUUID();
        const result = await this.sendToSessionWorker(sessionId, {
          type: 'task',
          taskId: executionTaskId,
          data: {
            action: 'executeSession'
          }
        });
        
        // Check if session completed and notify runtime
        if (result && result.status === 'completed') {
          this.log(`Session ${sessionId} completed, notifying runtime`);
          self.postMessage({
            type: 'sessionComplete',
            sessionId,
            result
          });
        }
        
        return {
          sessionId,
          status: 'started',
          result
        };
      }
      
      case 'getStatus': {
        return {
          ready: true,
          workspaceId: this.workspace?.id,
          sessions: this.sessions.size
        };
      }
      
      default:
        throw new Error(`Unknown task action: ${data.action}`);
    }
  }
  
  protected async cleanup(): Promise<void> {
    this.log("Cleaning up supervisor...");
    
    // Terminate all session workers
    for (const [sessionId, info] of this.sessions) {
      info.worker.postMessage({ type: 'shutdown' });
      info.worker.terminate();
      info.port.close();
    }
    
    this.sessions.clear();
    this.supervisor = null;
    this.workspace = null;
  }
  
  private async spawnSessionWorker(sessionId: string): Promise<SessionWorkerInfo> {
    this.log(`Spawning session worker: ${sessionId}`);
    
    // Create session worker with permissions to use BroadcastChannel
    const sessionWorker = new Worker(
      new URL("./session-supervisor-worker.ts", import.meta.url).href,
      { 
        type: "module",
        deno: {
          permissions: "inherit"
        }
      } as any
    );
    
    // Create message channel for direct communication
    const { port1, port2 } = new MessageChannel();
    
    // Store session info
    const sessionInfo: SessionWorkerInfo = {
      worker: sessionWorker,
      port: port1,
      sessionId
    };
    this.sessions.set(sessionId, sessionInfo);
    
    // Setup worker message handling
    sessionWorker.onmessage = (event) => {
      this.handleSessionMessage(sessionId, event.data);
    };
    
    sessionWorker.onerror = (error) => {
      this.log(`Session ${sessionId} error:`, error);
      self.postMessage({
        type: 'sessionError',
        sessionId,
        error: error.toString()
      });
    };
    
    // Initialize session
    sessionWorker.postMessage({
      type: 'init',
      id: sessionId,
      workerType: 'session',
      config: {
        sessionId,
        workspaceId: this.workspace?.id
      }
    });
    
    // Send port for direct communication
    sessionWorker.postMessage({
      type: 'setPort',
      peerId: 'supervisor',
      port: port2
    }, [port2]);
    
    // Setup port message handling
    port1.onmessage = (event) => {
      this.handleSessionDirectMessage(sessionId, event.data);
    };
    
    return sessionInfo;
  }
  
  private handleSessionMessage(sessionId: string, message: any): void {
    switch (message.type) {
      case 'initialized':
        this.log(`Session ${sessionId} initialized`);
        break;
        
      case 'agentSpawned':
        this.log(`Session ${sessionId} spawned agent: ${message.agentId}`);
        break;
        
      case 'sessionBroadcast':
        this.log(`Session ${sessionId} broadcast:`, message.data);
        // Could analyze agent communications
        break;
        
      default:
        this.log(`Session ${sessionId} message:`, message);
    }
  }
  
  private handleSessionDirectMessage(sessionId: string, message: any): void {
    this.log(`Session ${sessionId} direct message:`, message);
    
    // Handle coordination requests from sessions
    if (message.type === 'requestGuidance') {
      // Supervisor could provide guidance based on workspace goals
    }
  }
  
  // Helper to send tasks to session worker and wait for response
  private async sendToSessionWorker(sessionId: string, message: any): Promise<any> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Session worker timeout for task: ${message.taskId}`));
      }, 60000);
      
      // Listen for result
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'result' && event.data.taskId === message.taskId) {
          clearTimeout(timeout);
          sessionInfo.worker.removeEventListener('message', handleMessage);
          resolve(event.data.result);
        } else if (event.data.type === 'error' && event.data.taskId === message.taskId) {
          clearTimeout(timeout);
          sessionInfo.worker.removeEventListener('message', handleMessage);
          reject(new Error(event.data.error));
        }
      };
      
      sessionInfo.worker.addEventListener('message', handleMessage);
      sessionInfo.worker.postMessage(message);
    });
  }

  // Override to handle supervisor-specific messages
  protected override handleCustomMessage(message: any): void {
    switch (message.type) {
      case 'setWorkspace':
        if (this.supervisor && message.workspace) {
          this.workspace = message.workspace;
          this.supervisor.setWorkspace(this.workspace);
          self.postMessage({ type: 'workspaceSet' });
        }
        break;
        
      default:
        super.handleCustomMessage(message);
    }
  }
  
  // Handle broadcast messages from other agents
  protected override handleBroadcast(channel: string, data: any): void {
    this.log(`Received broadcast on ${channel}:`, data);
    
    // Supervisor could coordinate based on broadcasts
    if (data.type === 'agentMessage' && this.supervisor) {
      // Could track agent communications, etc.
    }
  }
}

// Create and start the worker
new WorkspaceSupervisorWorker();