#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

import { expect } from "@std/expect";
import { BaseNode, NodeContext, NodeStatus } from "../../../src/core/execution/behavior-trees/base-node.ts";
import { SequenceNode } from "../../../src/core/execution/behavior-trees/sequence-node.ts";
import { SelectorNode } from "../../../src/core/execution/behavior-trees/selector-node.ts";
import { ParallelNode } from "../../../src/core/execution/behavior-trees/parallel-node.ts";
import { ConditionNode } from "../../../src/core/execution/behavior-trees/condition-node.ts";
import { AgentActionNode } from "../../../src/core/execution/behavior-trees/agent-action-node.ts";

// Mock node for testing
class MockNode extends BaseNode {
  private returnStatus: NodeStatus;
  
  constructor(id: string, returnStatus: NodeStatus = NodeStatus.SUCCESS) {
    super({ id });
    this.returnStatus = returnStatus;
  }
  
  async execute(_context: NodeContext): Promise<NodeStatus> {
    // Simulate some work
    await new Promise(resolve => setTimeout(resolve, 10));
    return this.returnStatus;
  }
}

// Create test context
const createTestContext = (overrides?: Partial<NodeContext>): NodeContext => ({
  sessionId: crypto.randomUUID(),
  workspaceId: "test-workspace",
  currentInput: { test: "data" },
  globalState: {},
  agentExecutor: async (agentId: string, task: string, input: any) => {
    return `${agentId} processed: ${JSON.stringify(input)}`;
  },
  ...overrides,
});

Deno.test("BaseNode validation works", () => {
  const node = new MockNode("test-node");
  const validation = node.validate();
  
  expect(validation.valid).toBe(true);
  expect(validation.errors).toEqual([]);
});

Deno.test("BaseNode validation fails without ID", () => {
  const node = new MockNode("");
  const validation = node.validate();
  
  expect(validation.valid).toBe(false);
  expect(validation.errors).toContain("Node must have an ID");
});

Deno.test("SequenceNode executes children in order - all succeed", async () => {
  const sequence = new SequenceNode({ id: "test-sequence" });
  sequence.addChild(new MockNode("child1", NodeStatus.SUCCESS));
  sequence.addChild(new MockNode("child2", NodeStatus.SUCCESS));
  sequence.addChild(new MockNode("child3", NodeStatus.SUCCESS));
  
  const context = createTestContext();
  const result = await sequence.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
});

Deno.test("SequenceNode fails when any child fails", async () => {
  const sequence = new SequenceNode({ id: "test-sequence" });
  sequence.addChild(new MockNode("child1", NodeStatus.SUCCESS));
  sequence.addChild(new MockNode("child2", NodeStatus.FAILURE));
  sequence.addChild(new MockNode("child3", NodeStatus.SUCCESS));
  
  const context = createTestContext();
  const result = await sequence.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.FAILURE);
});

Deno.test("SelectorNode succeeds when first child succeeds", async () => {
  const selector = new SelectorNode({ id: "test-selector" });
  selector.addChild(new MockNode("child1", NodeStatus.SUCCESS));
  selector.addChild(new MockNode("child2", NodeStatus.FAILURE));
  
  const context = createTestContext();
  const result = await selector.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
});

Deno.test("SelectorNode tries next child when first fails", async () => {
  const selector = new SelectorNode({ id: "test-selector" });
  selector.addChild(new MockNode("child1", NodeStatus.FAILURE));
  selector.addChild(new MockNode("child2", NodeStatus.SUCCESS));
  
  const context = createTestContext();
  const result = await selector.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
});

Deno.test("SelectorNode fails when all children fail", async () => {
  const selector = new SelectorNode({ id: "test-selector" });
  selector.addChild(new MockNode("child1", NodeStatus.FAILURE));
  selector.addChild(new MockNode("child2", NodeStatus.FAILURE));
  
  const context = createTestContext();
  const result = await selector.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.FAILURE);
});

Deno.test("ParallelNode with 'all' policy succeeds when all children succeed", async () => {
  const parallel = new ParallelNode({
    id: "test-parallel",
    policy: "all"
  });
  parallel.addChild(new MockNode("child1", NodeStatus.SUCCESS));
  parallel.addChild(new MockNode("child2", NodeStatus.SUCCESS));
  
  const context = createTestContext();
  const result = await parallel.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
});

Deno.test("ParallelNode with 'all' policy fails when any child fails", async () => {
  const parallel = new ParallelNode({
    id: "test-parallel",
    policy: "all"
  });
  parallel.addChild(new MockNode("child1", NodeStatus.SUCCESS));
  parallel.addChild(new MockNode("child2", NodeStatus.FAILURE));
  
  const context = createTestContext();
  const result = await parallel.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.FAILURE);
});

Deno.test("ParallelNode with 'any' policy succeeds when one child succeeds", async () => {
  const parallel = new ParallelNode({
    id: "test-parallel",
    policy: "any"
  });
  parallel.addChild(new MockNode("child1", NodeStatus.FAILURE));
  parallel.addChild(new MockNode("child2", NodeStatus.SUCCESS));
  
  const context = createTestContext();
  const result = await parallel.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
});

Deno.test("ParallelNode with 'threshold' policy works correctly", async () => {
  const parallel = new ParallelNode({
    id: "test-parallel",
    policy: "threshold",
    threshold: 2
  });
  parallel.addChild(new MockNode("child1", NodeStatus.SUCCESS));
  parallel.addChild(new MockNode("child2", NodeStatus.SUCCESS));
  parallel.addChild(new MockNode("child3", NodeStatus.FAILURE));
  
  const context = createTestContext();
  const result = await parallel.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
});

Deno.test("ConditionNode evaluates simple boolean conditions", async () => {
  const trueCondition = new ConditionNode({
    id: "true-condition",
    condition: "true"
  });
  
  const falseCondition = new ConditionNode({
    id: "false-condition",
    condition: "false"
  });
  
  const context = createTestContext();
  
  expect(await trueCondition.executeWithRetry(context)).toBe(NodeStatus.SUCCESS);
  expect(await falseCondition.executeWithRetry(context)).toBe(NodeStatus.FAILURE);
});

Deno.test("ConditionNode evaluates predefined conditions", async () => {
  const hasInputCondition = new ConditionNode({
    id: "has-input",
    condition: "has_previous_output"
  });
  
  const contextWithInput = createTestContext({ currentInput: { data: "test" } });
  const contextWithoutInput = createTestContext({ currentInput: null });
  
  expect(await hasInputCondition.executeWithRetry(contextWithInput)).toBe(NodeStatus.SUCCESS);
  expect(await hasInputCondition.executeWithRetry(contextWithoutInput)).toBe(NodeStatus.FAILURE);
});

Deno.test("ConditionNode evaluates value path conditions", async () => {
  const condition = new ConditionNode({
    id: "value-condition",
    condition: "check_global_value",
    valuePath: "globalState.testValue",
    expectedValue: "expected",
    operator: "equals"
  });
  
  const contextWithValue = createTestContext({
    globalState: { testValue: "expected" }
  });
  
  const contextWithWrongValue = createTestContext({
    globalState: { testValue: "wrong" }
  });
  
  expect(await condition.executeWithRetry(contextWithValue)).toBe(NodeStatus.SUCCESS);
  expect(await condition.executeWithRetry(contextWithWrongValue)).toBe(NodeStatus.FAILURE);
});

Deno.test("AgentActionNode executes agent successfully", async () => {
  const agentNode = new AgentActionNode({
    id: "test-agent",
    agentId: "test-agent-id",
    task: "Process the input",
    inputSource: "previous"
  });
  
  const context = createTestContext({
    currentInput: { message: "test input" }
  });
  
  const result = await agentNode.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
  expect(context.currentInput).toContain("test-agent-id processed:");
});

Deno.test("AgentActionNode validates output with success criteria", async () => {
  const agentNode = new AgentActionNode({
    id: "test-agent",
    agentId: "test-agent-id",
    task: "Process the input",
    successCriteria: {
      minOutputLength: 10,
      requiredStrings: ["processed"]
    }
  });
  
  const context = createTestContext();
  const result = await agentNode.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.SUCCESS);
});

Deno.test("AgentActionNode fails when output doesn't meet criteria", async () => {
  const agentNode = new AgentActionNode({
    id: "test-agent",
    agentId: "test-agent-id", 
    task: "Process the input",
    successCriteria: {
      requiredStrings: ["missing-string"]
    }
  });
  
  const context = createTestContext();
  const result = await agentNode.executeWithRetry(context);
  
  expect(result).toBe(NodeStatus.FAILURE);
});

Deno.test("AgentActionNode stores output in global state", async () => {
  const agentNode = new AgentActionNode({
    id: "test-agent",
    agentId: "test-agent-id",
    task: "Process the input",
    outputKey: "agentOutput"
  });
  
  const context = createTestContext();
  await agentNode.executeWithRetry(context);
  
  expect(context.globalState.agentOutput).toBeDefined();
  expect(context.globalState.agentOutput).toContain("test-agent-id processed:");
});

Deno.test("AgentActionNode uses custom input", async () => {
  const customInput = { custom: "data" };
  const agentNode = new AgentActionNode({
    id: "test-agent",
    agentId: "test-agent-id",
    task: "Process the input",
    inputSource: "custom",
    customInput
  });
  
  const context = createTestContext();
  await agentNode.executeWithRetry(context);
  
  expect(context.currentInput).toContain(JSON.stringify(customInput));
});

Deno.test("Node timeout works correctly", async () => {
  // Create a node that takes longer than the timeout
  class SlowNode extends BaseNode {
    async execute(_context: NodeContext): Promise<NodeStatus> {
      await new Promise(resolve => setTimeout(resolve, 200));
      return NodeStatus.SUCCESS;
    }
  }
  
  const slowNode = new SlowNode({ id: "slow-node", timeout: 50 });
  const context = createTestContext();
  
  const result = await slowNode.executeWithRetry(context);
  expect(result).toBe(NodeStatus.FAILURE);
});

Deno.test("Node retry logic works", async () => {
  let attempts = 0;
  
  class FlakyNode extends BaseNode {
    async execute(_context: NodeContext): Promise<NodeStatus> {
      attempts++;
      if (attempts < 3) {
        throw new Error("Simulated failure");
      }
      return NodeStatus.SUCCESS;
    }
  }
  
  const flakyNode = new FlakyNode({ id: "flaky-node", retries: 3 });
  const context = createTestContext();
  
  const result = await flakyNode.executeWithRetry(context);
  expect(result).toBe(NodeStatus.SUCCESS);
  expect(attempts).toBe(3);
});