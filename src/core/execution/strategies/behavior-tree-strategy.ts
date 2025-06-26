/**
 * Behavior Tree Execution Strategy for Atlas
 * Implements dynamic control flow execution using agentic behavior trees
 */

import {
  BaseExecutionStrategy,
  type ExecutionResult,
  type ExecutionStep,
  type StrategyExecutionResult,
} from "../base-execution-strategy.ts";
import { NodeContext, NodeStatus } from "../behavior-trees/base-node.ts";
import {
  BehaviorTree,
  type BehaviorTreeExecutionResult,
  type BehaviorTreeSpec,
} from "../behavior-trees/behavior-tree.ts";

export class BehaviorTreeStrategy extends BaseExecutionStrategy {
  readonly name = "behavior-tree";
  readonly description = "Dynamic control flow execution using agentic behavior trees";

  private behaviorTree: BehaviorTree | null = null;

  async execute(steps: ExecutionStep[]): Promise<StrategyExecutionResult> {
    if (!this.context) {
      throw new Error("Strategy not initialized");
    }

    this.log("Starting behavior tree execution");

    try {
      // Convert steps to behavior tree or use provided tree spec
      this.behaviorTree = this.createBehaviorTreeFromSteps(steps);

      // Validate tree
      const validation = this.behaviorTree.validate();
      if (!validation.valid) {
        throw new Error(`Invalid behavior tree: ${validation.errors.join(", ")}`);
      }

      // Create execution context for behavior tree
      const nodeContext = this.createNodeContext();

      // Execute the behavior tree
      const treeResult = await this.behaviorTree.execute(nodeContext);

      this.log(`Behavior tree execution completed: ${treeResult.success ? "SUCCESS" : "FAILURE"}`);

      // Convert tree execution result to strategy result
      const executionResults = this.convertTreeResultToExecutionResults(treeResult);

      return this.createStrategyResult(treeResult.success, executionResults);
    } catch (error) {
      this.log(`Behavior tree execution failed: ${error}`, "error");
      return this.createStrategyResult(false, [], 0);
    }
  }

  validateSteps(steps: ExecutionStep[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (steps.length === 0) {
      errors.push("Behavior tree strategy requires at least one step");
    }

    // Validate that we can create a valid tree from these steps
    try {
      const tree = this.createBehaviorTreeFromSteps(steps);
      const treeValidation = tree.validate();
      if (!treeValidation.valid) {
        errors.push(...treeValidation.errors);
      }
    } catch (error) {
      errors.push(`Cannot create behavior tree: ${error}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  getConfigSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        tree: {
          type: "object",
          description: "Behavior tree specification",
          required: ["type", "id"],
          properties: {
            type: {
              type: "string",
              enum: ["sequence", "selector", "parallel", "condition", "agent"],
            },
            id: { type: "string" },
            name: { type: "string" },
            children: {
              type: "array",
              items: { $ref: "#/properties/tree" },
            },
          },
        },
        agentMapping: {
          type: "object",
          description: "Map execution step IDs to agent IDs",
        },
      },
    };
  }

  private createBehaviorTreeFromSteps(steps: ExecutionStep[]): BehaviorTree {
    // Check if the context contains a pre-built tree specification
    // Look for tree in the execution context which allows additional properties
    const executionContext = this.context?.jobSpec?.execution?.context;
    if (executionContext && typeof executionContext === "object" && "tree" in executionContext) {
      const tree = executionContext.tree;
      // Validate basic structure before using
      if (this.isValidBehaviorTreeSpec(tree)) {
        this.log("Using behavior tree from job specification");
        return new BehaviorTree(tree);
      }
    }

    // Build a tree from execution steps
    this.log("Building behavior tree from execution steps");

    if (steps.length === 1 && steps[0].type === "agent") {
      // Single agent - just create a simple agent node
      const spec: BehaviorTreeSpec = {
        type: "agent",
        id: steps[0].id,
        agentId: steps[0].agentId!,
        task: "Execute agent task",
        inputSource: "signal",
      };
      return new BehaviorTree(spec);
    }

    // Multiple steps - create sequence by default
    const children: BehaviorTreeSpec[] = steps.map((step, index) => {
      if (step.type === "agent") {
        return {
          type: "agent",
          id: step.id,
          agentId: step.agentId!,
          task: "Process input",
          inputSource: index === 0 ? "signal" : "previous",
        };
      } else if (step.type === "condition") {
        return {
          type: "condition",
          id: step.id,
          condition: step.condition || "true",
        };
      } else if (step.type === "parallel") {
        return {
          type: "parallel",
          id: step.id,
          policy: "all",
          children: step.children?.map((child) => this.stepToTreeSpec(child)) || [],
        };
      } else {
        // Default to sequence
        return {
          type: "sequence",
          id: step.id,
          children: step.children?.map((child) => this.stepToTreeSpec(child)) || [],
        };
      }
    });

    const rootSpec: BehaviorTreeSpec = {
      type: "sequence",
      id: "behavior-tree-root",
      name: "Generated Behavior Tree",
      children,
    };

    return new BehaviorTree(rootSpec);
  }

  private stepToTreeSpec(step: ExecutionStep): BehaviorTreeSpec {
    switch (step.type) {
      case "agent":
        return {
          type: "agent",
          id: step.id,
          agentId: step.agentId!,
          task: "Process input",
        };
      case "condition":
        return {
          type: "condition",
          id: step.id,
          condition: step.condition || "true",
        };
      case "parallel":
        return {
          type: "parallel",
          id: step.id,
          policy: "all",
          children: step.children?.map((child) => this.stepToTreeSpec(child)) || [],
        };
      default:
        return {
          type: "sequence",
          id: step.id,
          children: step.children?.map((child) => this.stepToTreeSpec(child)) || [],
        };
    }
  }

  private createNodeContext(): NodeContext {
    if (!this.context) {
      throw new Error("Execution context not available");
    }

    return {
      sessionId: this.context.sessionId,
      workspaceId: this.context.workspaceId,
      currentInput: this.context.payload,
      globalState: {
        originalPayload: this.context.payload,
        signal: this.context.signal,
        availableAgents: this.context.availableAgents,
      },
      agentExecutor: (agentId: string, task: string, input: Record<string, unknown>) => {
        // This would be provided by the session supervisor
        // For now, return a mock response
        this.log(`Agent executor called: ${agentId} with task: ${task}`);
        return Promise.resolve({
          agentId,
          task,
          input,
          result: `Agent ${agentId} processed input`,
          timestamp: new Date().toISOString(),
        });
      },
    };
  }

  private normalizePayload(payload: unknown): Record<string, unknown> {
    // If payload is already an object, return it
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return payload as Record<string, unknown>;
    }

    // Otherwise, wrap it in an object
    return {
      value: payload,
      _normalized: true,
    };
  }

  private convertTreeResultToExecutionResults(
    treeResult: BehaviorTreeExecutionResult,
  ): ExecutionResult[] {
    const results: ExecutionResult[] = [];

    for (const traceEntry of treeResult.executionTrace) {
      results.push(this.createExecutionResult(
        traceEntry.nodeId,
        traceEntry.status === NodeStatus.SUCCESS,
        `Node executed with status: ${traceEntry.status}`,
        traceEntry.duration,
        traceEntry.error,
        {
          nodeType: traceEntry.nodeType,
          startTime: traceEntry.startTime,
        },
      ));
    }

    return results;
  }

  private isValidBehaviorTreeSpec(value: unknown): value is BehaviorTreeSpec {
    if (!value || typeof value !== "object" || value === null) {
      return false;
    }
    // Type narrowing: after the check above, TS knows value is object & not null
    if (!("type" in value) || !("id" in value)) {
      return false;
    }
    // Now we can safely access these properties
    const validTypes = ["sequence", "selector", "parallel", "condition", "agent"];
    return (
      typeof value.type === "string" &&
      validTypes.includes(value.type) &&
      typeof value.id === "string"
    );
  }
}
