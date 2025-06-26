/**
 * Base node for Agentic Behavior Trees (ABT)
 * Provides the foundation for all behavior tree nodes
 */

export enum NodeStatus {
  SUCCESS = "success",
  FAILURE = "failure",
  RUNNING = "running",
}

export interface NodeContext {
  sessionId: string;
  workspaceId: string;
  currentInput: Record<string, unknown>;
  globalState: Record<string, unknown>;
  agentExecutor?: (
    agentId: string,
    task: string,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

export interface NodeConfig {
  id: string;
  name?: string;
  description?: string;
  timeout?: number;
  retries?: number;
}

// Private interface for timeout tracking
interface BaseNodePrivate {
  _timeoutId?: number;
}

// Serialized node representation
export interface SerializedNode {
  type: string;
  config: NodeConfig;
  children: SerializedNode[];
  status: NodeStatus;
}

export abstract class BaseNode {
  protected config: NodeConfig;
  protected children: BaseNode[] = [];
  protected status: NodeStatus = NodeStatus.RUNNING;
  protected startTime: number = 0;
  protected retryCount: number = 0;

  constructor(config: NodeConfig) {
    this.config = config;
  }

  // Main execution method - must be implemented by each node type
  abstract execute(context: NodeContext): Promise<NodeStatus>;

  // Add child node (for composite nodes)
  addChild(child: BaseNode): void {
    this.children.push(child);
  }

  // Get current status
  getStatus(): NodeStatus {
    return this.status;
  }

  // Get node configuration
  getConfig(): NodeConfig {
    return this.config;
  }

  // Get child nodes
  getChildren(): BaseNode[] {
    return this.children;
  }

  // Reset node to initial state
  reset(): void {
    this.status = NodeStatus.RUNNING;
    this.retryCount = 0;
    this.children.forEach((child) => child.reset());
  }

  // Check if node can be retried
  canRetry(): boolean {
    const maxRetries = this.config.retries || 0;
    return this.retryCount < maxRetries;
  }

  // Execute with retry logic
  async executeWithRetry(context: NodeContext): Promise<NodeStatus> {
    this.startTime = Date.now();

    try {
      // Check timeout
      if (this.config.timeout) {
        const result = await Promise.race([
          this.execute(context),
          this.createTimeoutPromise(this.config.timeout),
        ]);

        this.status = result;
        return result;
      } else {
        this.status = await this.execute(context);
        return this.status;
      }
    } catch (error) {
      this.log(`Node execution failed: ${error}`, "error");

      if (this.canRetry()) {
        this.retryCount++;
        this.log(`Retrying node (attempt ${this.retryCount}/${this.config.retries || 0})`);
        return this.executeWithRetry(context);
      }

      this.status = NodeStatus.FAILURE;
      return NodeStatus.FAILURE;
    }
  }

  // Create timeout promise
  private createTimeoutPromise(timeoutMs: number): Promise<NodeStatus> {
    return new Promise((_, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Node timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      // Store timeout ID for cleanup
      const nodeWithTimeout = this as BaseNode & BaseNodePrivate;
      nodeWithTimeout._timeoutId = timeoutId;
    });
  }

  // Validation method - override for custom validation
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this.config.id) {
      errors.push("Node must have an ID");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Convert node to JSON representation
  toJSON(): SerializedNode {
    return {
      type: this.constructor.name,
      config: this.config,
      children: this.children.map((child) => child.toJSON()),
      status: this.status,
    };
  }

  // Log helper with node context
  protected log(message: string, level: "info" | "warn" | "error" = "info"): void {
    const prefix = `[${this.constructor.name}] ${this.config.id}:`;
    if (level === "error") {
      console.error(`${prefix} ${message}`);
    } else if (level === "warn") {
      console.warn(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  // Helper to get execution duration
  protected getDuration(): number {
    return Date.now() - this.startTime;
  }
}
