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
  metadata: Record<string, any>;
}

export interface MCTSAction {
  id: string;
  type: "execute_step" | "modify_step" | "skip_step" | "retry_step";
  step?: ExecutionStep;
  parameters?: Record<string, any>;
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

  async execute(steps: ExecutionStep[]): Promise<StrategyExecutionResult> {
    const startTime = Date.now();

    try {
      // Initialize root state
      const initialState: MCTSState = {
        executedSteps: [],
        remainingSteps: [...steps],
        context: { globalState: {} },
        score: 0,
        metadata: {},
      };

      // Run MCTS to find optimal execution plan
      const mctsResult = await this.runMCTS(initialState);

      // Execute the best path found
      const executionResults = await this.executeBestPath(mctsResult.bestPath, steps);

      return {
        success: executionResults.every((r) => r.success),
        results: executionResults,
        executionTime: Date.now() - startTime,
        strategy: "monte-carlo-tree-search",
        metadata: {
          mctsResult,
          explorationStats: {
            totalNodes: this.countNodes(mctsResult.explorationTree),
            maxDepth: this.getMaxDepth(mctsResult.explorationTree),
            convergence: mctsResult.convergenceInfo,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        results: [],
        executionTime: Date.now() - startTime,
        strategy: "monte-carlo-tree-search",
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async runMCTS(initialState: MCTSState): Promise<MCTSResult> {
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
      const expandedNode = await this.expansion(leaf);
      const reward = await this.simulation(expandedNode);
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
  private async expansion(node: MCTSNode): Promise<MCTSNode> {
    if (node.isTerminal || node.visits < this.config.expansionThreshold) {
      return node;
    }

    if (node.untriedActions.length > 0) {
      // Select an untried action
      const actionIndex = Math.floor(this.rng() * node.untriedActions.length);
      const action = node.untriedActions.splice(actionIndex, 1)[0];

      // Create new state by applying the action
      const newState = await this.applyAction(node.state, action);

      // Create child node
      const child = this.createNode(node, newState);
      node.children.push(child);

      return child;
    }

    return node;
  }

  // Phase 3: Simulation - Random playout from leaf node
  private async simulation(node: MCTSNode): Promise<number> {
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
      currentState = await this.applyAction(currentState, action);
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
      state.context.globalState[`${step.agentId}_failed`]
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

  private async applyAction(state: MCTSState, action: MCTSAction): Promise<MCTSState> {
    const newState: MCTSState = {
      executedSteps: [...state.executedSteps],
      remainingSteps: [...state.remainingSteps],
      context: { globalState: { ...state.context.globalState } },
      score: state.score,
      metadata: { ...state.metadata },
    };

    switch (action.type) {
      case "execute_step":
        if (action.step && newState.remainingSteps.length > 0) {
          // Move step from remaining to executed
          const step = newState.remainingSteps.shift()!;
          newState.executedSteps.push(step);

          // Simulate execution result
          const success = this.simulateStepExecution(step, newState);
          newState.context.globalState[`${step.agentId}_executed`] = true;
          newState.context.globalState[`${step.agentId}_success`] = success;

          if (!success) {
            newState.context.globalState[`${step.agentId}_failed`] = true;
          }
        }
        break;

      case "modify_step":
        if (action.step && action.parameters) {
          // Apply modifications to the step
          const modifiedStep = { ...action.step, ...action.parameters };
          newState.remainingSteps[0] = modifiedStep;
          newState.metadata.modifications = newState.metadata.modifications || [];
          newState.metadata.modifications.push({
            step: action.step.agentId,
            changes: action.parameters,
          });
        }
        break;

      case "skip_step":
        if (newState.remainingSteps.length > 0) {
          const skippedStep = newState.remainingSteps.shift()!;
          newState.context.globalState[`${skippedStep.agentId}_skipped`] = true;
          newState.metadata.skippedSteps = newState.metadata.skippedSteps || [];
          newState.metadata.skippedSteps.push(skippedStep.agentId);
        }
        break;

      case "retry_step":
        if (action.step) {
          // Reset failure state and add back to execution
          delete newState.context.globalState[`${action.step.agentId}_failed`];
          newState.remainingSteps.unshift(action.step);
          newState.metadata.retries = newState.metadata.retries || [];
          newState.metadata.retries.push(action.step.agentId);
        }
        break;
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

  private async executeBestPath(
    actions: MCTSAction[],
    originalSteps: ExecutionStep[],
  ): Promise<Array<{ success: boolean; result?: any; error?: string }>> {
    const results = [];

    for (const action of actions) {
      try {
        if (action.step) {
          // Execute the step - this would integrate with actual agent execution
          const result = await this.executeStep(action.step);
          results.push({ success: true, result });
        }
      } catch (error) {
        results.push({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  private async executeStep(step: ExecutionStep): Promise<any> {
    // Placeholder - would integrate with actual agent execution system
    return {
      agentId: step.agentId,
      input: step.input,
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
    const failures = Object.keys(state.context.globalState)
      .filter((key) => key.endsWith("_failed")).length;
    reward -= failures * 15;

    // Bonus for completing all steps
    if (state.remainingSteps.length === 0) {
      reward += 50;
    }

    // Penalty for skipped steps
    const skipped = state.metadata.skippedSteps?.length || 0;
    reward -= skipped * 5;

    return reward;
  }

  private estimateStepReward(step: ExecutionStep, state: MCTSState): number {
    // Estimate based on step importance and context
    let reward = 10; // Base reward for executing a step

    // Higher reward for steps that unlock subsequent steps
    if (step.agentId === "critical-agent") reward += 5;

    // Lower reward if similar step recently failed
    if (state.context.globalState[`${step.agentId}_failed`]) {
      reward -= 3;
    }

    return reward;
  }

  private estimateModificationReward(step: ExecutionStep, state: MCTSState): number {
    // Modification can improve success rate but adds complexity
    return 8;
  }

  private estimateSkipReward(step: ExecutionStep, state: MCTSState): number {
    // Skipping saves time but loses potential value
    return 3;
  }

  private estimateRetryReward(step: ExecutionStep, state: MCTSState): number {
    // Retry has chance to recover from failure
    return 7;
  }

  // Helper functions for step analysis
  private canModifyStep(step: ExecutionStep, state: MCTSState): boolean {
    // Check if step has modifiable parameters
    return step.input && typeof step.input === "object";
  }

  private canSkipStep(step: ExecutionStep, state: MCTSState): boolean {
    // Check if step is optional/non-critical
    return !step.agentId.includes("critical");
  }

  private generateModificationOptions(step: ExecutionStep, state: MCTSState): Record<string, any> {
    // Generate reasonable modifications based on step and context
    return {
      timeout: (step as any).timeout ? (step as any).timeout * 1.5 : 30000,
      retries: 2,
    };
  }

  private simulateStepExecution(step: ExecutionStep, state: MCTSState): boolean {
    // Simulate whether step would succeed
    // In reality, this would use historical data or heuristics
    const baseSuccessRate = 0.8;
    const failureBonus = state.context.globalState[`${step.agentId}_failed`] ? -0.2 : 0;

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
}
