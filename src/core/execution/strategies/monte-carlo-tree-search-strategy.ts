/**
 * Monte Carlo Tree Search (MCTS) Strategy
 *
 * MCTS is an exploration-based algorithm that builds a search tree incrementally
 * and asymmetrically. It's particularly effective for:
 * - Optimization problems with large search spaces
 * - Finding optimal execution paths
 * - Handling uncertainty in agent responses
 * - Balancing exploration vs exploitation
 */

import {
  BaseExecutionStrategy,
  ExecutionContext,
  ExecutionResult,
  ExecutionStep,
  StrategyExecutionResult,
} from "../base-execution-strategy.ts";

// MCTS Core Interfaces
export interface MCTSNode {
  id: string;
  state: MCTSState;
  parent: MCTSNode | null;
  children: MCTSNode[];
  visits: number;
  totalReward: number;
  untriedActions: MCTSAction[];
  isTerminal: boolean;
  depth: number;
}

export interface MCTSState {
  executedSteps: ExecutionStep[];
  remainingSteps: ExecutionStep[];
  context: ExecutionContext;
  score: number;
  metadata: Record<string, unknown>;
}

export interface MCTSAction {
  id: string;
  type: "execute_step" | "modify_step" | "skip_step" | "retry_step";
  step?: ExecutionStep;
  parameters?: Record<string, unknown>;
  expectedReward: number;
}

export interface MCTSConfig {
  maxIterations: number;
  explorationConstant: number; // UCB1 exploration parameter (typically √2)
  maxDepth: number;
  simulationPolicy: "random" | "heuristic" | "learned";
  rewardFunction: (state: MCTSState) => number;
  expansionThreshold: number; // Minimum visits before expansion
  timeLimit?: number; // Max time in milliseconds
}

export interface MCTSResult {
  bestPath: MCTSAction[];
  explorationTree: MCTSNode;
  iterations: number;
  convergenceInfo: {
    bestScore: number;
    averageScore: number;
    explorationRate: number;
  };
}

export class MonteCarloTreeSearchStrategy extends BaseExecutionStrategy {
  readonly name = "monte-carlo-tree-search";
  readonly description = "Optimization-based execution using MCTS for finding optimal paths";
  private config: MCTSConfig;
  private rootNode: MCTSNode | null = null;
  private rng: () => number;

  constructor(config: Partial<MCTSConfig> = {}) {
    super();
    this.config = {
      maxIterations: config.maxIterations || 1000,
      explorationConstant: config.explorationConstant || Math.sqrt(2),
      maxDepth: config.maxDepth || 10,
      simulationPolicy: config.simulationPolicy || "heuristic",
      rewardFunction: config.rewardFunction || this.defaultRewardFunction,
      expansionThreshold: config.expansionThreshold || 5,
      timeLimit: config.timeLimit || 30000, // 30 seconds
      ...config,
    };
    this.rng = Math.random; // Could be replaced with seeded RNG for reproducibility
  }

  execute(steps: ExecutionStep[]): StrategyExecutionResult {
    try {
      // Initialize root state
      const initialState: MCTSState = {
        executedSteps: [],
        remainingSteps: [...steps],
        context: this.context || {
          sessionId: "",
          workspaceId: "",
          signal: {},
          payload: {},
          availableAgents: [],
        },
        score: 0,
        metadata: {
          globalState: {},
        },
      };

      // Run MCTS to find optimal execution plan
      const mctsResult = this.runMCTS(initialState);

      // Execute the best path found
      const executionResults = this.executeBestPath(mctsResult.bestPath, steps);

      return this.createStrategyResult(
        executionResults.every((r) => r.success),
        executionResults,
        mctsResult.iterations,
      );
    } catch (_error) {
      return this.createStrategyResult(false, [], 0);
    }
  }

  private runMCTS(initialState: MCTSState): MCTSResult {
    // Create root node
    this.rootNode = this.createNode(null, initialState);

    const startTime = Date.now();
    let iteration = 0;
    const scores: number[] = [];

    while (
      iteration < this.config.maxIterations &&
      (this.config.timeLimit === undefined || Date.now() - startTime < this.config.timeLimit)
    ) {
      // MCTS main loop: Selection → Expansion → Simulation → Backpropagation
      const leaf = this.selection(this.rootNode);
      const expandedNode = this.expansion(leaf);
      const reward = this.simulation(expandedNode);
      this.backpropagation(expandedNode, reward);

      scores.push(reward);
      iteration++;
    }

    // Extract best path
    const bestPath = this.extractBestPath(this.rootNode);

    return {
      bestPath,
      explorationTree: this.rootNode,
      iterations: iteration,
      convergenceInfo: {
        bestScore: Math.max(...scores),
        averageScore: scores.reduce((a, b) => a + b, 0) / scores.length,
        explorationRate: this.calculateExplorationRate(this.rootNode),
      },
    };
  }

  // Phase 1: Selection - Navigate down the tree using UCB1
  private selection(node: MCTSNode): MCTSNode {
    while (!node.isTerminal && node.untriedActions.length === 0) {
      if (node.children.length === 0) break;

      // Use UCB1 (Upper Confidence Bound) for selection
      node = this.ucb1Select(node);
    }
    return node;
  }

  private ucb1Select(node: MCTSNode): MCTSNode {
    let bestChild = node.children[0];
    let bestValue = -Infinity;

    for (const child of node.children) {
      const exploitation = child.totalReward / child.visits;
      const exploration = this.config.explorationConstant *
        Math.sqrt(Math.log(node.visits) / child.visits);
      const ucb1Value = exploitation + exploration;

      if (ucb1Value > bestValue) {
        bestValue = ucb1Value;
        bestChild = child;
      }
    }

    return bestChild;
  }

  // Phase 2: Expansion - Add new child nodes
  private expansion(node: MCTSNode): MCTSNode {
    if (node.isTerminal || node.visits < this.config.expansionThreshold) {
      return node;
    }

    if (node.untriedActions.length > 0) {
      // Select an untried action
      const actionIndex = Math.floor(this.rng() * node.untriedActions.length);
      const action = node.untriedActions.splice(actionIndex, 1)[0];

      // Create new state by applying the action
      const newState = this.applyAction(node.state, action);

      // Create child node
      const child = this.createNode(node, newState);
      node.children.push(child);

      return child;
    }

    return node;
  }

  // Phase 3: Simulation - Random playout from leaf node
  private simulation(node: MCTSNode): number {
    let currentState = { ...node.state };
    let totalReward = this.config.rewardFunction(currentState);
    let depth = 0;

    // Simulate until terminal state or max depth
    while (!this.isTerminalState(currentState) && depth < this.config.maxDepth) {
      const availableActions = this.getAvailableActions(currentState);

      if (availableActions.length === 0) break;

      // Select action based on simulation policy
      const action = this.selectActionForSimulation(availableActions, currentState);

      // Apply action and update state
      currentState = this.applyAction(currentState, action);
      totalReward += this.config.rewardFunction(currentState);
      depth++;
    }

    return totalReward;
  }

  // Phase 4: Backpropagation - Update statistics up the tree
  private backpropagation(node: MCTSNode, reward: number): void {
    let current: MCTSNode | null = node;

    while (current !== null) {
      current.visits++;
      current.totalReward += reward;
      current = current.parent;
    }
  }

  private createNode(parent: MCTSNode | null, state: MCTSState): MCTSNode {
    return {
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      state: { ...state },
      parent,
      children: [],
      visits: 0,
      totalReward: 0,
      untriedActions: this.getAvailableActions(state),
      isTerminal: this.isTerminalState(state),
      depth: parent ? parent.depth + 1 : 0,
    };
  }

  private getAvailableActions(state: MCTSState): MCTSAction[] {
    const actions: MCTSAction[] = [];

    // If there are remaining steps, we can execute the next one
    if (state.remainingSteps.length > 0) {
      const nextStep = state.remainingSteps[0];

      actions.push({
        id: `execute-${nextStep.agentId}`,
        type: "execute_step",
        step: nextStep,
        expectedReward: this.estimateStepReward(nextStep, state),
      });

      // Optional: Add step modification actions
      if (this.canModifyStep(nextStep, state)) {
        actions.push({
          id: `modify-${nextStep.agentId}`,
          type: "modify_step",
          step: nextStep,
          parameters: this.generateModificationOptions(nextStep, state),
          expectedReward: this.estimateModificationReward(nextStep, state),
        });
      }

      // Optional: Add skip action for non-critical steps
      if (this.canSkipStep(nextStep, state)) {
        actions.push({
          id: `skip-${nextStep.agentId}`,
          type: "skip_step",
          step: nextStep,
          expectedReward: this.estimateSkipReward(nextStep, state),
        });
      }
    }

    // Optional: Add retry actions for failed steps
    const failedSteps = state.executedSteps.filter((step) =>
      state.metadata.globalState && state.metadata.globalState[`${step.agentId}_failed`]
    );

    for (const failedStep of failedSteps) {
      actions.push({
        id: `retry-${failedStep.agentId}`,
        type: "retry_step",
        step: failedStep,
        expectedReward: this.estimateRetryReward(failedStep, state),
      });
    }

    return actions;
  }

  private applyAction(state: MCTSState, action: MCTSAction): MCTSState {
    const newState: MCTSState = {
      executedSteps: [...state.executedSteps],
      remainingSteps: [...state.remainingSteps],
      context: state.context,
      score: state.score,
      metadata: { ...state.metadata },
    };

    switch (action.type) {
      case "execute_step": {
        if (action.step && newState.remainingSteps.length > 0) {
          // Move step from remaining to executed
          const step = newState.remainingSteps.shift()!;
          newState.executedSteps.push(step);

          // Simulate execution result
          const success = this.simulateStepExecution(step, newState);

          // Ensure globalState exists
          if (!newState.metadata.globalState) {
            newState.metadata.globalState = {};
          }
          const globalState = newState.metadata.globalState;
          if (typeof globalState === "object" && globalState !== null) {
            globalState[`${step.agentId}_executed`] = true;
            globalState[`${step.agentId}_success`] = success;

            if (!success) {
              globalState[`${step.agentId}_failed`] = true;
            }
          }
        }
        break;
      }

      case "modify_step": {
        if (action.step && action.parameters) {
          // Apply modifications to the step
          const modifiedStep = { ...action.step, ...action.parameters };
          newState.remainingSteps[0] = modifiedStep;

          // Initialize modifications array if needed
          if (!newState.metadata.modifications) {
            newState.metadata.modifications = [];
          }
          const modifications = newState.metadata.modifications;
          if (Array.isArray(modifications)) {
            modifications.push({
              step: action.step.agentId!,
              changes: action.parameters,
            });
          }
        }
        break;
      }

      case "skip_step": {
        if (newState.remainingSteps.length > 0) {
          const skippedStep = newState.remainingSteps.shift()!;

          // Ensure globalState exists and set skipped flag
          if (!newState.metadata.globalState) {
            newState.metadata.globalState = {};
          }
          const globalState = newState.metadata.globalState;
          if (typeof globalState === "object" && globalState !== null) {
            globalState[`${skippedStep.agentId}_skipped`] = true;
          }

          // Initialize skippedSteps array if needed
          if (!newState.metadata.skippedSteps) {
            newState.metadata.skippedSteps = [];
          }
          const skippedSteps = newState.metadata.skippedSteps;
          if (Array.isArray(skippedSteps)) {
            skippedSteps.push(skippedStep.agentId!);
          }
        }
        break;
      }

      case "retry_step": {
        if (action.step) {
          // Reset failure state and add back to execution
          const globalState = newState.metadata.globalState;
          if (typeof globalState === "object" && globalState !== null) {
            delete globalState[`${action.step.agentId}_failed`];
          }
          newState.remainingSteps.unshift(action.step);

          // Initialize retries array if needed
          if (!newState.metadata.retries) {
            newState.metadata.retries = [];
          }
          const retries = newState.metadata.retries;
          if (Array.isArray(retries)) {
            retries.push(action.step.agentId!);
          }
        }
        break;
      }
    }

    // Update state score
    newState.score = this.config.rewardFunction(newState);

    return newState;
  }

  private isTerminalState(state: MCTSState): boolean {
    // Terminal if no more steps to execute
    return state.remainingSteps.length === 0;
  }

  private selectActionForSimulation(actions: MCTSAction[], state: MCTSState): MCTSAction {
    switch (this.config.simulationPolicy) {
      case "random":
        return actions[Math.floor(this.rng() * actions.length)];

      case "heuristic":
        // Prefer actions with higher expected rewards
        actions.sort((a, b) => b.expectedReward - a.expectedReward);
        return actions[0];

      case "learned":
        // This would use a learned policy - for now, fall back to heuristic
        return this.selectActionForSimulation(actions, state);

      default:
        return actions[0];
    }
  }

  private extractBestPath(root: MCTSNode): MCTSAction[] {
    const path: MCTSAction[] = [];
    let current = root;

    while (current.children.length > 0) {
      // Select child with highest average reward
      current = current.children.reduce((best, child) =>
        (child.totalReward / child.visits) > (best.totalReward / best.visits) ? child : best
      );

      // Find the action that led to this child
      // This is simplified - in a full implementation, we'd track the action
      if (current.state.executedSteps.length > 0) {
        const lastStep = current.state.executedSteps[current.state.executedSteps.length - 1];
        path.push({
          id: `best-${lastStep.agentId}`,
          type: "execute_step",
          step: lastStep,
          expectedReward: current.totalReward / current.visits,
        });
      }
    }

    return path;
  }

  private executeBestPath(
    actions: MCTSAction[],
    _originalSteps: ExecutionStep[],
  ): ExecutionResult[] {
    const results: ExecutionResult[] = [];

    for (const action of actions) {
      const startTime = Date.now();
      try {
        if (action.step) {
          // Execute the step - this would integrate with actual agent execution
          const result = this.executeStep(action.step);
          results.push({
            stepId: action.step.id,
            success: true,
            output: result,
            duration: Date.now() - startTime,
            metadata: {
              actionType: action.type,
              actionId: action.id,
            },
          });
        }
      } catch (_error) {
        results.push({
          stepId: action.step?.id || action.id,
          success: false,
          output: null,
          duration: Date.now() - startTime,
          error: _error instanceof Error ? _error.message : String(_error),
        });
      }
    }

    return results;
  }

  private executeStep(step: ExecutionStep): unknown {
    // Placeholder - would integrate with actual agent execution system
    return {
      agentId: step.agentId,
      input: step.config || {},
      output: `Result from ${step.agentId}`,
      executionTime: 100 + Math.random() * 900, // 100-1000ms
    };
  }

  // Reward and estimation functions
  private defaultRewardFunction(state: MCTSState): number {
    let reward = 0;

    // Reward for completing steps
    reward += state.executedSteps.length * 10;

    // Penalty for failed steps
    const failures = Object.keys(state.metadata.globalState || {})
      .filter((key) => key.endsWith("_failed")).length;
    reward -= failures * 15;

    // Bonus for completing all steps
    if (state.remainingSteps.length === 0) {
      reward += 50;
    }

    // Penalty for skipped steps
    const skippedSteps = state.metadata.skippedSteps;
    const skipped = Array.isArray(skippedSteps) ? skippedSteps.length : 0;
    reward -= skipped * 5;

    return reward;
  }

  private estimateStepReward(step: ExecutionStep, state: MCTSState): number {
    // Estimate based on step importance and context
    let reward = 10; // Base reward for executing a step

    // Higher reward for steps that unlock subsequent steps
    if (step.agentId === "critical-agent") reward += 5;

    // Lower reward if similar step recently failed
    if (state.metadata.globalState && state.metadata.globalState[`${step.agentId}_failed`]) {
      reward -= 3;
    }

    return reward;
  }

  private estimateModificationReward(_step: ExecutionStep, _state: MCTSState): number {
    // Modification can improve success rate but adds complexity
    return 8;
  }

  private estimateSkipReward(_step: ExecutionStep, _state: MCTSState): number {
    // Skipping saves time but loses potential value
    return 3;
  }

  private estimateRetryReward(_step: ExecutionStep, _state: MCTSState): number {
    // Retry has chance to recover from failure
    return 7;
  }

  // Helper functions for step analysis
  private canModifyStep(step: ExecutionStep, _state: MCTSState): boolean {
    // Check if step has modifiable parameters
    return step.config !== undefined && typeof step.config === "object";
  }

  private canSkipStep(step: ExecutionStep, _state: MCTSState): boolean {
    // Check if step is optional/non-critical
    return !step.agentId.includes("critical");
  }

  private generateModificationOptions(
    step: ExecutionStep,
    _state: MCTSState,
  ): Record<string, unknown> {
    // Generate reasonable modifications based on step and context
    return {
      timeout: (() => {
        const timeout = step.config?.timeout;
        return typeof timeout === "number" ? timeout * 1.5 : 30000;
      })(),
      retries: 2,
    };
  }

  private simulateStepExecution(step: ExecutionStep, state: MCTSState): boolean {
    // Simulate whether step would succeed
    // In reality, this would use historical data or heuristics
    const baseSuccessRate = 0.8;
    const failureBonus =
      (state.metadata.globalState && state.metadata.globalState[`${step.agentId}_failed`])
        ? -0.2
        : 0;

    return this.rng() < baseSuccessRate + failureBonus;
  }

  // Tree analysis utilities
  private countNodes(node: MCTSNode): number {
    let count = 1;
    for (const child of node.children) {
      count += this.countNodes(child);
    }
    return count;
  }

  private getMaxDepth(node: MCTSNode): number {
    if (node.children.length === 0) return node.depth;

    return Math.max(...node.children.map((child) => this.getMaxDepth(child)));
  }

  private calculateExplorationRate(node: MCTSNode): number {
    const totalNodes = this.countNodes(node);
    const leafNodes = this.countLeafNodes(node);
    return leafNodes / totalNodes;
  }

  private countLeafNodes(node: MCTSNode): number {
    if (node.children.length === 0) return 1;

    return node.children.reduce((count, child) => count + this.countLeafNodes(child), 0);
  }

  validateSteps(steps: ExecutionStep[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (steps.length === 0) {
      errors.push("MCTS strategy requires at least one step");
    }

    // Validate that steps have required properties
    for (const step of steps) {
      if (!step.id) {
        errors.push("All steps must have an id");
      }
      if (step.type === "agent" && !step.agentId) {
        errors.push(`Step ${step.id} is an agent step but missing agentId`);
      }
    }

    // Check config validity
    if (this.config.maxIterations <= 0) {
      errors.push("maxIterations must be positive");
    }
    if (this.config.maxDepth <= 0) {
      errors.push("maxDepth must be positive");
    }
    if (this.config.explorationConstant < 0) {
      errors.push("explorationConstant must be non-negative");
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
        maxIterations: {
          type: "number",
          description: "Maximum number of MCTS iterations",
          default: 1000,
          minimum: 1,
        },
        explorationConstant: {
          type: "number",
          description: "UCB1 exploration parameter (typically √2)",
          default: Math.sqrt(2),
          minimum: 0,
        },
        maxDepth: {
          type: "number",
          description: "Maximum tree depth",
          default: 10,
          minimum: 1,
        },
        simulationPolicy: {
          type: "string",
          description: "Simulation policy for rollouts",
          enum: ["random", "heuristic", "learned"],
          default: "heuristic",
        },
        expansionThreshold: {
          type: "number",
          description: "Minimum visits before node expansion",
          default: 5,
          minimum: 1,
        },
        timeLimit: {
          type: "number",
          description: "Maximum time in milliseconds",
          default: 30000,
          minimum: 100,
        },
      },
    };
  }
}
