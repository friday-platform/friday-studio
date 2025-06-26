/**
 * Hierarchical Task Network (HTN) Strategy
 *
 * HTN is a planning approach that decomposes complex goals into simpler tasks
 * through a hierarchy of methods and operators. It's particularly effective for:
 * - Complex multi-step workflows
 * - Goal-oriented task decomposition
 * - Conditional execution based on world state
 * - Recursive task breakdown
 */

import {
  BaseExecutionStrategy,
  ExecutionContext,
  ExecutionResult,
  ExecutionStep,
  StrategyExecutionResult,
} from "../base-execution-strategy.ts";

// HTN Core Interfaces
export interface HTNTask {
  id: string;
  name: string;
  type: "compound" | "primitive";
  preconditions?: HTNCondition[];
  effects?: HTNEffect[];
  parameters?: Record<string, unknown>;
}

export interface HTNMethod {
  id: string;
  task: string; // Task this method can decompose
  name: string;
  preconditions?: HTNCondition[];
  subtasks: HTNSubtask[];
  ordering?: HTNOrdering[];
}

export interface HTNSubtask {
  id: string;
  task: string;
  parameters?: Record<string, unknown>;
  binding?: Record<string, string>; // Variable bindings
}

export interface HTNCondition {
  type: "equals" | "not_equals" | "greater" | "less" | "exists" | "custom";
  property: string;
  value?: unknown;
  custom_check?: (context: ExecutionContext) => boolean;
}

export interface HTNEffect {
  type: "set" | "add" | "remove";
  property: string;
  value?: unknown;
}

export interface HTNOrdering {
  before: string; // Task ID that must come before
  after: string; // Task ID that must come after
}

export interface HTNDomain {
  tasks: HTNTask[];
  methods: HTNMethod[];
  operators: HTNOperator[]; // Primitive task implementations
}

export interface HTNOperator {
  id: string;
  task: string; // Primitive task this operator implements
  preconditions?: HTNCondition[];
  effects?: HTNEffect[];
  agentId?: string;
  action: string;
}

export interface HTNPlan {
  steps: HTNPlanStep[];
  decomposition: HTNDecomposition[];
}

export interface HTNPlanStep {
  id: string;
  operator: HTNOperator;
  parameters: Record<string, unknown>;
  worldState: Record<string, unknown>;
}

export interface HTNDecomposition {
  task: HTNTask;
  method: HTNMethod;
  subtasks: HTNDecomposition[];
}

export interface HTNWorldState {
  [key: string]: unknown;
}

export class HierarchicalTaskNetworkStrategy extends BaseExecutionStrategy {
  readonly name = "hierarchical-task-network";
  readonly description = "Goal-oriented task decomposition using HTN planning";
  private domain: HTNDomain;
  private worldState: HTNWorldState;
  private maxDecompositionDepth: number;
  private currentDepth: number = 0;

  constructor(domain: HTNDomain, initialWorldState: HTNWorldState = {}, maxDepth = 10) {
    super();
    this.domain = domain;
    this.worldState = { ...initialWorldState };
    this.maxDecompositionDepth = maxDepth;
  }

  async execute(steps: ExecutionStep[]): Promise<StrategyExecutionResult> {
    const _startTime = Date.now();

    try {
      // Convert execution steps to HTN goal tasks
      const goalTasks = this.convertStepsToGoals(steps);

      // Generate HTN plan
      const plan = await this.generateHTNPlan(goalTasks);

      if (!plan) {
        return this.createStrategyResult(false, [], 0);
      }

      // Execute the generated plan
      const results = this.executePlan(plan);

      return this.createStrategyResult(
        results.every((r) => r.success),
        results,
        this.currentDepth,
      );
    } catch (_error) {
      return this.createStrategyResult(false, [], 0);
    }
  }

  private convertStepsToGoals(steps: ExecutionStep[]): HTNTask[] {
    return steps.map((step, index) => ({
      id: `goal-${index}`,
      name: `Goal ${index + 1}`,
      type: "compound" as const,
      parameters: {
        agentId: step.agentId,
        config: step.config,
        expectedOutputs: step.expectedOutputs,
      },
    }));
  }

  private async generateHTNPlan(goalTasks: HTNTask[]): Promise<HTNPlan | null> {
    this.currentDepth = 0;
    const decompositions: HTNDecomposition[] = [];
    const planSteps: HTNPlanStep[] = [];

    for (const goal of goalTasks) {
      const decomposition = await this.decomposeTask(goal, this.worldState);

      if (!decomposition) {
        return null; // Failed to decompose a goal
      }

      decompositions.push(decomposition);

      // Extract primitive steps from decomposition
      const primitiveSteps = this.extractPrimitiveSteps(decomposition);
      planSteps.push(...primitiveSteps);
    }

    return {
      steps: planSteps,
      decomposition: decompositions,
    };
  }

  private async decomposeTask(
    task: HTNTask,
    worldState: HTNWorldState,
  ): Promise<HTNDecomposition | null> {
    if (this.currentDepth >= this.maxDecompositionDepth) {
      throw new Error(`Maximum decomposition depth (${this.maxDecompositionDepth}) exceeded`);
    }

    // If it's a primitive task, find matching operator
    if (task.type === "primitive") {
      const operator = this.findOperator(task, worldState);
      if (!operator) return null;

      return {
        task,
        method: this.createTrivialMethod(task),
        subtasks: [],
      };
    }

    // Find applicable methods for compound task
    const applicableMethods = this.findApplicableMethods(task, worldState);

    if (applicableMethods.length === 0) {
      return null; // No method can decompose this task
    }

    // Try methods in order until one succeeds
    for (const method of applicableMethods) {
      this.currentDepth++;

      try {
        const subtaskDecompositions: HTNDecomposition[] = [];
        let currentWorldState = { ...worldState };
        let validDecomposition = true;

        // Decompose all subtasks
        for (const subtask of method.subtasks) {
          const subtaskDef = this.findTask(subtask.task);
          if (!subtaskDef) {
            validDecomposition = false;
            break;
          }

          // Apply parameter bindings
          const boundTask = this.applyBindings(subtaskDef, subtask.binding || {});
          const subtaskDecomposition = await this.decomposeTask(boundTask, currentWorldState);

          if (!subtaskDecomposition) {
            validDecomposition = false;
            break;
          }

          subtaskDecompositions.push(subtaskDecomposition);

          // Update world state with effects
          currentWorldState = this.applyEffects(currentWorldState, subtaskDecomposition);
        }

        if (validDecomposition) {
          this.currentDepth--;
          return {
            task,
            method,
            subtasks: subtaskDecompositions,
          };
        }
      } catch (_error) {
        // Try next method
        continue;
      } finally {
        this.currentDepth--;
      }
    }

    return null; // No method succeeded
  }

  private findApplicableMethods(task: HTNTask, worldState: HTNWorldState): HTNMethod[] {
    return this.domain.methods
      .filter((method) =>
        method.task === task.name &&
        this.checkPreconditions(method.preconditions || [], worldState)
      )
      .sort((a, b) => {
        // Prefer methods with fewer subtasks (simpler decomposition)
        return a.subtasks.length - b.subtasks.length;
      });
  }

  private findOperator(task: HTNTask, worldState: HTNWorldState): HTNOperator | null {
    return this.domain.operators.find((op) =>
      op.task === task.name &&
      this.checkPreconditions(op.preconditions || [], worldState)
    ) || null;
  }

  private findTask(taskName: string): HTNTask | null {
    return this.domain.tasks.find((t) => t.name === taskName) || null;
  }

  private checkPreconditions(conditions: HTNCondition[], worldState: HTNWorldState): boolean {
    return conditions.every((condition) => {
      if (condition.custom_check) {
        return condition.custom_check(
          this.context || {
            sessionId: "",
            workspaceId: "",
            signal: {},
            payload: worldState,
            availableAgents: [],
          },
        );
      }

      const value = worldState[condition.property];

      switch (condition.type) {
        case "equals":
          return value === condition.value;
        case "not_equals":
          return value !== condition.value;
        case "greater":
          return Number(value) > Number(condition.value);
        case "less":
          return Number(value) < Number(condition.value);
        case "exists":
          return value !== undefined && value !== null;
        default:
          return false;
      }
    });
  }

  private applyBindings(task: HTNTask, bindings: Record<string, string>): HTNTask {
    const boundTask = { ...task };

    if (boundTask.parameters) {
      boundTask.parameters = { ...boundTask.parameters };

      for (const [param, binding] of Object.entries(bindings)) {
        if (boundTask.parameters[param] !== undefined) {
          boundTask.parameters[param] = binding;
        }
      }
    }

    return boundTask;
  }

  private applyEffects(worldState: HTNWorldState, decomposition: HTNDecomposition): HTNWorldState {
    const newState = { ...worldState };
    const effects = this.getEffectsFromDecomposition(decomposition);

    for (const effect of effects) {
      switch (effect.type) {
        case "set":
          newState[effect.property] = effect.value;
          break;
        case "add": {
          const currentValue = newState[effect.property];
          if (Array.isArray(currentValue)) {
            newState[effect.property] = [...currentValue, effect.value];
          } else {
            newState[effect.property] = effect.value;
          }
          break;
        }
        case "remove": {
          const currentValue = newState[effect.property];
          if (Array.isArray(currentValue)) {
            newState[effect.property] = currentValue.filter((v) => v !== effect.value);
          } else {
            delete newState[effect.property];
          }
          break;
        }
      }
    }

    return newState;
  }

  private getEffectsFromDecomposition(decomposition: HTNDecomposition): HTNEffect[] {
    const effects: HTNEffect[] = [];

    // Add effects from the task itself
    if (decomposition.task.effects) {
      effects.push(...decomposition.task.effects);
    }

    // Add effects from method
    // (Methods typically don't have direct effects, but we could extend this)

    // Recursively collect effects from subtasks
    for (const subtask of decomposition.subtasks) {
      effects.push(...this.getEffectsFromDecomposition(subtask));
    }

    return effects;
  }

  private extractPrimitiveSteps(decomposition: HTNDecomposition): HTNPlanStep[] {
    const steps: HTNPlanStep[] = [];

    if (decomposition.task.type === "primitive") {
      const operator = this.findOperator(decomposition.task, this.worldState);
      if (operator) {
        steps.push({
          id: `step-${decomposition.task.id}`,
          operator,
          parameters: decomposition.task.parameters || {},
          worldState: { ...this.worldState },
        });
      }
    }

    // Recursively extract from subtasks
    for (const subtask of decomposition.subtasks) {
      steps.push(...this.extractPrimitiveSteps(subtask));
    }

    return steps;
  }

  private createTrivialMethod(task: HTNTask): HTNMethod {
    return {
      id: `trivial-${task.id}`,
      task: task.name,
      name: `Trivial method for ${task.name}`,
      subtasks: [],
      ordering: [],
    };
  }

  private executePlan(
    plan: HTNPlan,
  ): ExecutionResult[] {
    const results: ExecutionResult[] = [];

    for (const step of plan.steps) {
      const startTime = Date.now();
      try {
        // Update world state with step's world state
        this.worldState = { ...step.worldState };

        // Execute the operator
        const result = this.executeOperator(step.operator, step.parameters);

        // Apply operator effects
        if (step.operator.effects) {
          for (const effect of step.operator.effects) {
            this.applyEffect(effect);
          }
        }

        results.push({
          stepId: step.id,
          success: true,
          output: result,
          duration: Date.now() - startTime,
          metadata: {
            operator: step.operator.id,
            worldState: { ...this.worldState },
          },
        });
      } catch (_error) {
        results.push({
          stepId: step.id,
          success: false,
          output: null,
          duration: Date.now() - startTime,
          error: _error instanceof Error ? _error.message : String(_error),
        });

        // Continue execution or break depending on strategy
        // For now, we continue
      }
    }

    return results;
  }

  private executeOperator(
    operator: HTNOperator,
    parameters: Record<string, unknown>,
  ): unknown {
    // This would integrate with the actual agent execution system
    // For now, we simulate execution

    if (operator.agentId) {
      // Execute agent-based operator
      return {
        operator: operator.id,
        agent: operator.agentId,
        action: operator.action,
        parameters,
        result: `Executed ${operator.action} with ${operator.agentId}`,
      };
    } else {
      // Execute direct action
      return {
        operator: operator.id,
        action: operator.action,
        parameters,
        result: `Executed action ${operator.action}`,
      };
    }
  }

  private applyEffect(effect: HTNEffect): void {
    switch (effect.type) {
      case "set":
        this.worldState[effect.property] = effect.value;
        break;
      case "add": {
        const currentValue = this.worldState[effect.property];
        if (Array.isArray(currentValue)) {
          currentValue.push(effect.value);
        } else {
          this.worldState[effect.property] = effect.value;
        }
        break;
      }
      case "remove": {
        const currentValue = this.worldState[effect.property];
        if (Array.isArray(currentValue)) {
          this.worldState[effect.property] = currentValue.filter((v) => v !== effect.value);
        } else {
          delete this.worldState[effect.property];
        }
        break;
      }
    }
  }

  validateSteps(steps: ExecutionStep[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (steps.length === 0) {
      errors.push("HTN strategy requires at least one goal step");
    }

    // Check that we have a valid domain
    if (!this.domain || !this.domain.tasks || !this.domain.methods || !this.domain.operators) {
      errors.push("HTN strategy requires a valid domain with tasks, methods, and operators");
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

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  getConfigSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        domain: {
          type: "object",
          description: "HTN domain specification",
          required: ["tasks", "methods", "operators"],
          properties: {
            tasks: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "name", "type"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  type: { type: "string", enum: ["compound", "primitive"] },
                  preconditions: { type: "array" },
                  effects: { type: "array" },
                  parameters: { type: "object" },
                },
              },
            },
            methods: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "task", "name", "subtasks"],
                properties: {
                  id: { type: "string" },
                  task: { type: "string" },
                  name: { type: "string" },
                  preconditions: { type: "array" },
                  subtasks: { type: "array" },
                  ordering: { type: "array" },
                },
              },
            },
            operators: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "task", "action"],
                properties: {
                  id: { type: "string" },
                  task: { type: "string" },
                  action: { type: "string" },
                  preconditions: { type: "array" },
                  effects: { type: "array" },
                  agentId: { type: "string" },
                },
              },
            },
          },
        },
        initialWorldState: {
          type: "object",
          description: "Initial world state for HTN planning",
        },
        maxDecompositionDepth: {
          type: "number",
          description: "Maximum depth for task decomposition",
          default: 10,
        },
      },
    };
  }

  // Public methods for domain building
  static createDomain(): HTNDomainBuilder {
    return new HTNDomainBuilder();
  }

  // Factory method for common domains
  static createAgentWorkflowDomain(): HTNDomain {
    return new HTNDomainBuilder()
      .addTask({
        id: "execute-workflow",
        name: "execute-workflow",
        type: "compound",
      })
      .addTask({
        id: "execute-agent",
        name: "execute-agent",
        type: "primitive",
      })
      .addTask({
        id: "validate-output",
        name: "validate-output",
        type: "primitive",
      })
      .addMethod({
        id: "sequential-workflow",
        task: "execute-workflow",
        name: "Sequential Agent Execution",
        subtasks: [
          { id: "sub1", task: "execute-agent" },
          { id: "sub2", task: "validate-output" },
        ],
      })
      .addOperator({
        id: "agent-op",
        task: "execute-agent",
        action: "invoke-agent",
        preconditions: [
          { type: "exists", property: "agentId" },
        ],
        effects: [
          { type: "set", property: "lastAgentOutput", value: "agent-result" },
        ],
      })
      .addOperator({
        id: "validate-op",
        task: "validate-output",
        action: "validate-result",
        preconditions: [
          { type: "exists", property: "lastAgentOutput" },
        ],
      })
      .build();
  }
}

// Builder pattern for creating HTN domains
export class HTNDomainBuilder {
  private tasks: HTNTask[] = [];
  private methods: HTNMethod[] = [];
  private operators: HTNOperator[] = [];

  addTask(task: HTNTask): this {
    this.tasks.push(task);
    return this;
  }

  addMethod(method: HTNMethod): this {
    this.methods.push(method);
    return this;
  }

  addOperator(operator: HTNOperator): this {
    this.operators.push(operator);
    return this;
  }

  build(): HTNDomain {
    return {
      tasks: [...this.tasks],
      methods: [...this.methods],
      operators: [...this.operators],
    };
  }
}
