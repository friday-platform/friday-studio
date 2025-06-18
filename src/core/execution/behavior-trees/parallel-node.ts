/**
 * Parallel Node for Behavior Trees
 * Executes all children simultaneously
 */

import { BaseNode, NodeContext, NodeStatus } from "./base-node.ts";

export interface ParallelNodeConfig {
  id: string;
  name?: string;
  description?: string;
  // Policy for determining success/failure
  policy: "all" | "any" | "threshold";
  // For threshold policy: minimum successes needed
  threshold?: number;
  // Timeout for parallel execution
  timeout?: number;
}

export class ParallelNode extends BaseNode {
  private childStatuses: Map<string, NodeStatus> = new Map();
  private runningChildren: Set<string> = new Set();

  constructor(config: ParallelNodeConfig) {
    super(config);
  }

  async execute(context: NodeContext): Promise<NodeStatus> {
    this.log(`Starting parallel execution with ${this.children.length} children`);

    // If no children, succeed immediately
    if (this.children.length === 0) {
      this.log("No children to execute, returning SUCCESS");
      return NodeStatus.SUCCESS;
    }

    // Initialize child tracking
    this.childStatuses.clear();
    this.runningChildren.clear();

    // Start all children in parallel
    const childPromises = this.children.map(async (child) => {
      const childId = child.getConfig().id;
      this.runningChildren.add(childId);

      try {
        const status = await child.executeWithRetry(context);
        this.childStatuses.set(childId, status);
        this.runningChildren.delete(childId);

        this.log(`Child ${childId} completed with status: ${status}`);
        return { childId, status };
      } catch (error) {
        this.log(`Child ${childId} failed with error: ${error}`, "error");
        this.childStatuses.set(childId, NodeStatus.FAILURE);
        this.runningChildren.delete(childId);
        return { childId, status: NodeStatus.FAILURE };
      }
    });

    // Wait for all children to complete or determine result early
    let completedChildren = 0;
    const totalChildren = this.children.length;

    try {
      await Promise.all(childPromises);
    } catch (error) {
      this.log(`Parallel execution error: ${error}`, "error");
    }

    // Evaluate final result based on policy
    return this.evaluateResult();
  }

  private evaluateResult(): NodeStatus {
    const policy = (this.config as ParallelNodeConfig).policy;
    const successes =
      Array.from(this.childStatuses.values()).filter((s) => s === NodeStatus.SUCCESS).length;
    const failures =
      Array.from(this.childStatuses.values()).filter((s) => s === NodeStatus.FAILURE).length;
    const running =
      Array.from(this.childStatuses.values()).filter((s) => s === NodeStatus.RUNNING).length;
    const total = this.children.length;

    this.log(
      `Parallel result: ${successes} successes, ${failures} failures, ${running} running out of ${total} total`,
    );

    // If any children still running, we're still running
    if (running > 0) {
      return NodeStatus.RUNNING;
    }

    switch (policy) {
      case "all":
        // All children must succeed
        return successes === total ? NodeStatus.SUCCESS : NodeStatus.FAILURE;

      case "any":
        // At least one child must succeed
        return successes > 0 ? NodeStatus.SUCCESS : NodeStatus.FAILURE;

      case "threshold":
        // Minimum number of successes required
        const threshold = (this.config as ParallelNodeConfig).threshold || 1;
        return successes >= threshold ? NodeStatus.SUCCESS : NodeStatus.FAILURE;

      default:
        this.log(`Unknown policy: ${policy}, defaulting to 'all'`, "warn");
        return successes === total ? NodeStatus.SUCCESS : NodeStatus.FAILURE;
    }
  }

  // Reset parallel state
  override reset(): void {
    super.reset();
    this.childStatuses.clear();
    this.runningChildren.clear();
  }

  // Validate parallel node
  override validate(): { valid: boolean; errors: string[] } {
    const baseValidation = super.validate();
    const errors = [...baseValidation.errors];
    const config = this.config as ParallelNodeConfig;

    if (this.children.length === 0) {
      errors.push("Parallel node should have at least one child");
    }

    if (!config.policy) {
      errors.push("Parallel node must specify a policy (all, any, threshold)");
    }

    if (config.policy === "threshold" && (config.threshold === undefined || config.threshold < 1)) {
      errors.push("Parallel node with threshold policy must specify threshold >= 1");
    }

    if (
      config.policy === "threshold" && config.threshold && config.threshold > this.children.length
    ) {
      errors.push("Parallel node threshold cannot be greater than number of children");
    }

    // Validate all children
    for (const child of this.children) {
      const childValidation = child.validate();
      if (!childValidation.valid) {
        errors.push(`Child ${child.getConfig().id}: ${childValidation.errors.join(", ")}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
