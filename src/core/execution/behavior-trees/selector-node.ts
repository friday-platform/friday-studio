/**
 * Selector Node for Behavior Trees
 * Executes children in order, succeeds if ANY child succeeds
 */

import { BaseNode, NodeContext, NodeStatus } from "./base-node.ts";

export class SelectorNode extends BaseNode {
  private currentChildIndex: number = 0;

  async execute(context: NodeContext): Promise<NodeStatus> {
    this.log(`Starting selector execution with ${this.children.length} children`);

    // If no children, fail immediately
    if (this.children.length === 0) {
      this.log("No children to execute, returning FAILURE");
      return NodeStatus.FAILURE;
    }

    // Try children in order until one succeeds
    for (let i = this.currentChildIndex; i < this.children.length; i++) {
      this.currentChildIndex = i;
      const child = this.children[i];

      this.log(`Trying child ${i + 1}/${this.children.length}: ${child.getConfig().id}`);

      const childStatus = await child.executeWithRetry(context);

      this.log(`Child ${child.getConfig().id} returned: ${childStatus}`);

      if (childStatus === NodeStatus.SUCCESS) {
        // If any child succeeds, selector succeeds
        this.log(`Selector succeeded with child ${i + 1}`);
        this.currentChildIndex = 0; // Reset for next execution
        return NodeStatus.SUCCESS;
      }

      if (childStatus === NodeStatus.RUNNING) {
        // If any child is still running, selector is running
        this.log(`Selector still running (child ${i + 1} running)`);
        return NodeStatus.RUNNING;
      }

      // Child failed, try next
      this.log(`Child ${i + 1} failed, trying next child`);
    }

    // All children failed
    this.log("All children failed, selector complete");
    this.currentChildIndex = 0; // Reset for next execution
    return NodeStatus.FAILURE;
  }

  // Reset selector state
  override reset(): void {
    super.reset();
    this.currentChildIndex = 0;
  }

  // Validate selector node
  override validate(): { valid: boolean; errors: string[] } {
    const baseValidation = super.validate();
    const errors = [...baseValidation.errors];

    if (this.children.length === 0) {
      errors.push("Selector node should have at least one child");
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
