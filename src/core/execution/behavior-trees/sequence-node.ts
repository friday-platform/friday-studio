/**
 * Sequence Node for Behavior Trees
 * Executes children in order, succeeds only if ALL children succeed
 */

import { BaseNode, NodeContext, NodeStatus } from "./base-node.ts";

export class SequenceNode extends BaseNode {
  private currentChildIndex: number = 0;
  
  async execute(context: NodeContext): Promise<NodeStatus> {
    this.log(`Starting sequence execution with ${this.children.length} children`);
    
    // If no children, succeed immediately
    if (this.children.length === 0) {
      this.log("No children to execute, returning SUCCESS");
      return NodeStatus.SUCCESS;
    }
    
    // Execute children sequentially
    for (let i = this.currentChildIndex; i < this.children.length; i++) {
      this.currentChildIndex = i;
      const child = this.children[i];
      
      this.log(`Executing child ${i + 1}/${this.children.length}: ${child.getConfig().id}`);
      
      const childStatus = await child.executeWithRetry(context);
      
      this.log(`Child ${child.getConfig().id} returned: ${childStatus}`);
      
      if (childStatus === NodeStatus.FAILURE) {
        // If any child fails, sequence fails
        this.log(`Sequence failed at child ${i + 1}`);
        this.currentChildIndex = 0; // Reset for next execution
        return NodeStatus.FAILURE;
      }
      
      if (childStatus === NodeStatus.RUNNING) {
        // If any child is still running, sequence is running
        this.log(`Sequence still running (child ${i + 1} running)`);
        return NodeStatus.RUNNING;
      }
      
      // Child succeeded, continue to next
    }
    
    // All children succeeded
    this.log("All children succeeded, sequence complete");
    this.currentChildIndex = 0; // Reset for next execution
    return NodeStatus.SUCCESS;
  }
  
  // Reset sequence state
  override reset(): void {
    super.reset();
    this.currentChildIndex = 0;
  }
  
  // Validate sequence node
  override validate(): { valid: boolean; errors: string[] } {
    const baseValidation = super.validate();
    const errors = [...baseValidation.errors];
    
    if (this.children.length === 0) {
      errors.push("Sequence node should have at least one child");
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
      errors
    };
  }
}