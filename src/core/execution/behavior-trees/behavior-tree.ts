/**
 * Behavior Tree implementation for Atlas agent orchestration
 * Provides dynamic control flow execution for complex agent coordination
 */

import { BaseNode, NodeContext, NodeStatus } from "./base-node.ts";
import { SequenceNode } from "./sequence-node.ts";
import { SelectorNode } from "./selector-node.ts";
import { ParallelNode, type ParallelNodeConfig } from "./parallel-node.ts";
import { ConditionNode, type ConditionNodeConfig } from "./condition-node.ts";
import { AgentActionNode, type AgentActionNodeConfig } from "./agent-action-node.ts";

export interface BehaviorTreeSpec {
  type: "sequence" | "selector" | "parallel" | "condition" | "agent";
  id: string;
  name?: string;
  description?: string;
  config?: any;
  children?: BehaviorTreeSpec[];
  
  // Agent-specific properties
  agentId?: string;
  task?: string;
  inputSource?: "signal" | "previous" | "global" | "custom";
  customInput?: any;
  outputKey?: string;
  successCriteria?: any;
  
  // Condition-specific properties
  condition?: string;
  expectedValue?: any;
  operator?: string;
  valuePath?: string;
  
  // Parallel-specific properties
  policy?: "all" | "any" | "threshold";
  threshold?: number;
  
  // Common properties
  timeout?: number;
  retries?: number;
}

export interface BehaviorTreeExecutionResult {
  success: boolean;
  rootStatus: NodeStatus;
  executionTrace: ExecutionTraceEntry[];
  duration: number;
  nodeStatuses: Map<string, NodeStatus>;
}

export interface ExecutionTraceEntry {
  nodeId: string;
  nodeType: string;
  status: NodeStatus;
  startTime: number;
  duration: number;
  error?: string;
}

export class BehaviorTree {
  private rootNode: BaseNode | null = null;
  private executionTrace: ExecutionTraceEntry[] = [];
  private nodeStatuses: Map<string, NodeStatus> = new Map();
  
  constructor(spec: BehaviorTreeSpec) {
    this.rootNode = this.buildNodeFromSpec(spec);
  }
  
  // Build node tree from specification
  private buildNodeFromSpec(spec: BehaviorTreeSpec): BaseNode {
    let node: BaseNode;
    
    switch (spec.type) {
      case "sequence":
        node = new SequenceNode({
          id: spec.id,
          name: spec.name,
          description: spec.description,
          timeout: spec.timeout,
          retries: spec.retries,
        });
        break;
        
      case "selector":
        node = new SelectorNode({
          id: spec.id,
          name: spec.name,
          description: spec.description,
          timeout: spec.timeout,
          retries: spec.retries,
        });
        break;
        
      case "parallel":
        const parallelConfig: ParallelNodeConfig = {
          id: spec.id,
          name: spec.name,
          description: spec.description,
          policy: spec.policy || "all",
          threshold: spec.threshold,
          timeout: spec.timeout,
        };
        node = new ParallelNode(parallelConfig);
        break;
        
      case "condition":
        const conditionConfig: ConditionNodeConfig = {
          id: spec.id,
          name: spec.name,
          description: spec.description,
          condition: spec.condition || "true",
          expectedValue: spec.expectedValue,
          operator: spec.operator as any,
          valuePath: spec.valuePath,
        };
        node = new ConditionNode(conditionConfig);
        break;
        
      case "agent":
        const agentConfig: AgentActionNodeConfig = {
          id: spec.id,
          name: spec.name,
          description: spec.description,
          agentId: spec.agentId!,
          task: spec.task!,
          inputSource: spec.inputSource,
          customInput: spec.customInput,
          outputKey: spec.outputKey,
          successCriteria: spec.successCriteria,
        };
        node = new AgentActionNode(agentConfig);
        break;
        
      default:
        throw new Error(`Unknown node type: ${spec.type}`);
    }
    
    // Add children if specified
    if (spec.children) {
      for (const childSpec of spec.children) {
        const childNode = this.buildNodeFromSpec(childSpec);
        node.addChild(childNode);
      }
    }
    
    return node;
  }
  
  // Execute the behavior tree
  async execute(context: NodeContext): Promise<BehaviorTreeExecutionResult> {
    const startTime = Date.now();
    this.executionTrace = [];
    this.nodeStatuses = new Map();
    
    if (!this.rootNode) {
      throw new Error("No root node defined");
    }
    
    // Set up execution tracing
    const originalExecutor = context.agentExecutor;
    context.agentExecutor = async (agentId: string, task: string, input: any) => {
      if (originalExecutor) {
        return await originalExecutor(agentId, task, input);
      }
      throw new Error("No agent executor provided");
    };
    
    try {
      const rootStatus = await this.executeNodeWithTracing(this.rootNode, context);
      const duration = Date.now() - startTime;
      
      return {
        success: rootStatus === NodeStatus.SUCCESS,
        rootStatus,
        executionTrace: this.executionTrace,
        duration,
        nodeStatuses: this.nodeStatuses,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      return {
        success: false,
        rootStatus: NodeStatus.FAILURE,
        executionTrace: this.executionTrace,
        duration,
        nodeStatuses: this.nodeStatuses,
      };
    }
  }
  
  // Execute node with execution tracing
  private async executeNodeWithTracing(node: BaseNode, context: NodeContext): Promise<NodeStatus> {
    const nodeId = node.getConfig().id;
    const nodeType = node.constructor.name;
    const startTime = Date.now();
    
    try {
      const status = await node.executeWithRetry(context);
      const duration = Date.now() - startTime;
      
      this.nodeStatuses.set(nodeId, status);
      this.executionTrace.push({
        nodeId,
        nodeType,
        status,
        startTime,
        duration,
      });
      
      return status;
    } catch (error) {
      const duration = Date.now() - startTime;
      const status = NodeStatus.FAILURE;
      
      this.nodeStatuses.set(nodeId, status);
      this.executionTrace.push({
        nodeId,
        nodeType,
        status,
        startTime,
        duration,
        error: error instanceof Error ? error.message : String(error),
      });
      
      throw error;
    }
  }
  
  // Validate the entire tree
  validate(): { valid: boolean; errors: string[] } {
    if (!this.rootNode) {
      return {
        valid: false,
        errors: ["No root node defined"]
      };
    }
    
    return this.validateNode(this.rootNode);
  }
  
  // Validate a node and its children recursively
  private validateNode(node: BaseNode): { valid: boolean; errors: string[] } {
    const validation = node.validate();
    let errors = [...validation.errors];
    
    // Validate children
    for (const child of node.getChildren()) {
      const childValidation = this.validateNode(child);
      if (!childValidation.valid) {
        errors = errors.concat(childValidation.errors);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  // Reset the tree to initial state
  reset(): void {
    if (this.rootNode) {
      this.rootNode.reset();
    }
    this.executionTrace = [];
    this.nodeStatuses.clear();
  }
  
  // Get tree structure as JSON
  toJSON(): any {
    return {
      root: this.rootNode?.toJSON(),
      lastExecution: {
        trace: this.executionTrace,
        nodeStatuses: Object.fromEntries(this.nodeStatuses),
      }
    };
  }
  
  // Create behavior tree from job specification
  static fromJobSpec(jobSpec: any): BehaviorTree {
    if (!jobSpec.execution?.tree) {
      throw new Error("Job specification must include execution.tree for behavior tree strategy");
    }
    
    return new BehaviorTree(jobSpec.execution.tree);
  }
  
  // Create a simple sequential behavior tree from agent list
  static createSequential(agents: { id: string; task?: string }[]): BehaviorTree {
    const children: BehaviorTreeSpec[] = agents.map((agent, index) => ({
      type: "agent",
      id: `agent-${index}`,
      agentId: agent.id,
      task: agent.task || `Process with ${agent.id}`,
      inputSource: index === 0 ? "signal" : "previous",
    }));
    
    const spec: BehaviorTreeSpec = {
      type: "sequence",
      id: "sequential-root",
      name: "Sequential Agent Execution",
      children,
    };
    
    return new BehaviorTree(spec);
  }
  
  // Create a parallel behavior tree from agent list
  static createParallel(agents: { id: string; task?: string }[], policy: "all" | "any" | "threshold" = "all", threshold?: number): BehaviorTree {
    const children: BehaviorTreeSpec[] = agents.map((agent, index) => ({
      type: "agent",
      id: `agent-${index}`,
      agentId: agent.id,
      task: agent.task || `Process with ${agent.id}`,
      inputSource: "signal", // All agents get original signal in parallel
    }));
    
    const spec: BehaviorTreeSpec = {
      type: "parallel",
      id: "parallel-root",
      name: "Parallel Agent Execution",
      policy,
      threshold,
      children,
    };
    
    return new BehaviorTree(spec);
  }
}