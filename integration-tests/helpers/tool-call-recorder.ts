/**
 * Tool Call Recorder
 * 
 * Records and verifies MCP tool calls during agent execution for testing.
 */

export interface ToolCall {
  toolName: string;
  serverName: string;
  args: any;
  result?: any;
  error?: any;
  timestamp: number;
  duration?: number;
}

export class ToolCallRecorder {
  private calls: ToolCall[] = [];
  private interceptors = new Map<string, (args: any) => any>();

  /**
   * Record a tool call
   */
  recordCall(call: Omit<ToolCall, "timestamp">): void {
    this.calls.push({
      ...call,
      timestamp: Date.now(),
    });
  }

  /**
   * Record tool call with timing
   */
  async recordTimedCall<T>(
    toolName: string,
    serverName: string,
    args: any,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    
    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      
      this.recordCall({
        toolName,
        serverName,
        args,
        result,
        duration,
      });
      
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      
      this.recordCall({
        toolName,
        serverName,
        args,
        error,
        duration,
      });
      
      throw error;
    }
  }

  /**
   * Get all recorded calls
   */
  getCalls(): ToolCall[] {
    return [...this.calls];
  }

  /**
   * Get calls for a specific tool
   */
  getCallsForTool(toolName: string): ToolCall[] {
    return this.calls.filter(call => call.toolName === toolName);
  }

  /**
   * Get calls for a specific server
   */
  getCallsForServer(serverName: string): ToolCall[] {
    return this.calls.filter(call => call.serverName === serverName);
  }

  /**
   * Clear all recorded calls
   */
  clear(): void {
    this.calls = [];
  }

  /**
   * Add an interceptor for a tool
   */
  addInterceptor(toolName: string, interceptor: (args: any) => any): void {
    this.interceptors.set(toolName, interceptor);
  }

  /**
   * Get interceptor for a tool
   */
  getInterceptor(toolName: string): ((args: any) => any) | undefined {
    return this.interceptors.get(toolName);
  }

  /**
   * Verify a sequence of calls
   */
  verifyCallSequence(expectedSequence: Array<{
    toolName: string;
    serverName?: string;
  }>): boolean {
    if (this.calls.length < expectedSequence.length) {
      return false;
    }
    
    let callIndex = 0;
    for (const expected of expectedSequence) {
      const found = this.calls.slice(callIndex).findIndex(call => 
        call.toolName === expected.toolName &&
        (!expected.serverName || call.serverName === expected.serverName)
      );
      
      if (found === -1) {
        return false;
      }
      
      callIndex += found + 1;
    }
    
    return true;
  }

  /**
   * Verify no calls were made to specific tools
   */
  verifyNoCalls(toolNames: string[]): boolean {
    return !this.calls.some(call => toolNames.includes(call.toolName));
  }

  /**
   * Get call statistics
   */
  getStats(): {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    byTool: Record<string, number>;
    byServer: Record<string, number>;
    averageDuration: number;
  } {
    const byTool: Record<string, number> = {};
    const byServer: Record<string, number> = {};
    let totalDuration = 0;
    let timedCalls = 0;
    
    for (const call of this.calls) {
      byTool[call.toolName] = (byTool[call.toolName] || 0) + 1;
      byServer[call.serverName] = (byServer[call.serverName] || 0) + 1;
      
      if (call.duration !== undefined) {
        totalDuration += call.duration;
        timedCalls++;
      }
    }
    
    const successfulCalls = this.calls.filter(c => !c.error).length;
    const failedCalls = this.calls.filter(c => c.error).length;
    
    return {
      totalCalls: this.calls.length,
      successfulCalls,
      failedCalls,
      byTool,
      byServer,
      averageDuration: timedCalls > 0 ? totalDuration / timedCalls : 0,
    };
  }

  /**
   * Create a snapshot of current state
   */
  createSnapshot(): {
    calls: ToolCall[];
    stats: ReturnType<typeof this.getStats>;
    timestamp: number;
  } {
    return {
      calls: this.getCalls(),
      stats: this.getStats(),
      timestamp: Date.now(),
    };
  }

  /**
   * Assert tool was called with specific arguments
   */
  assertToolCalledWith(
    toolName: string,
    expectedArgs: any,
    serverName?: string,
  ): void {
    const found = this.calls.find(call =>
      call.toolName === toolName &&
      (!serverName || call.serverName === serverName) &&
      JSON.stringify(call.args) === JSON.stringify(expectedArgs)
    );
    
    if (!found) {
      throw new Error(
        `Tool ${toolName} was not called with expected arguments: ${JSON.stringify(expectedArgs)}`
      );
    }
  }

  /**
   * Assert tool was called at least N times
   */
  assertToolCalledTimes(
    toolName: string,
    expectedCount: number,
    serverName?: string,
  ): void {
    const calls = this.calls.filter(call =>
      call.toolName === toolName &&
      (!serverName || call.serverName === serverName)
    );
    
    if (calls.length !== expectedCount) {
      throw new Error(
        `Tool ${toolName} was called ${calls.length} times, expected ${expectedCount}`
      );
    }
  }
}