import { expect } from "@std/expect";

// Test the agent execution worker with multi-provider support
Deno.test({
  name: "Agent Worker - Multi-Provider LLM Execution",
  async fn() {
    // Create a test worker
    const worker = new Worker(
      new URL("../../src/core/workers/agent-execution-worker.ts", import.meta.url),
      { type: "module" },
    );

    let workerReady = false;
    let executionResult: any = null;
    let workerError: any = null;

    // Listen for worker messages
    worker.addEventListener("message", (event) => {
      const { type, data } = event.data;

      if (type === "ready") {
        workerReady = true;
      } else if (type === "execution_complete") {
        executionResult = data;
      } else if (type === "error") {
        workerError = data;
      }
    });

    // Listen for worker errors
    worker.addEventListener("error", (event) => {
      workerError = event.error || event.message;
    });

    // Wait for worker to be ready with timeout
    const readyTimeout = setTimeout(() => {
      if (!workerReady) {
        worker.terminate();
        throw new Error("Worker failed to initialize within timeout");
      }
    }, 10000);

    while (!workerReady && !workerError) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    clearTimeout(readyTimeout);

    if (workerError) {
      worker.terminate();
      throw new Error(`Worker initialization failed: ${workerError}`);
    }

    // Test Anthropic provider
    const anthropicRequest = {
      type: "execute",
      id: "test-anthropic",
      data: {
        agent_id: "test-anthropic-agent",
        agent_config: {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          parameters: {
            provider: "anthropic",
            temperature: 0,
            max_tokens: 50,
          },
          prompts: {
            system: "You are a helpful assistant.",
          },
          tools: [],
        },
        task: {
          task: "Simple test",
          inputSource: "test",
        },
        input: "What is 2+2?",
        environment: {
          worker_config: {
            memory_limit: 128,
            timeout: 30000,
            allowed_permissions: ["read"],
            isolation_level: "sandbox",
          },
          monitoring_config: {
            log_level: "info",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      },
    };

    worker.postMessage(anthropicRequest);

    // Wait for execution result
    let anthropicAttempts = 0;
    while (!executionResult && anthropicAttempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      anthropicAttempts++;
    }

    if (executionResult) {
      console.log("Anthropic worker result:", executionResult);
      expect(executionResult.success).toBe(true);
      expect(executionResult.output.provider).toBe("anthropic");
      expect(typeof executionResult.output.result).toBe("string");
    } else {
      console.warn("Anthropic test timed out - may need API key");
      throw new Error("Anthropic provider test failed - no response received");
    }

    // Reset for next test
    executionResult = null;

    // Test OpenAI provider
    const openaiRequest = {
      type: "execute",
      id: "test-openai",
      data: {
        agent_id: "test-openai-agent",
        agent_config: {
          type: "llm",
          model: "gpt-3.5-turbo",
          parameters: {
            provider: "openai",
            temperature: 0,
            max_tokens: 50,
          },
          prompts: {
            system: "You are a helpful assistant.",
          },
          tools: [],
        },
        task: {
          task: "Simple test",
          inputSource: "test",
        },
        input: "What is 3+3?",
        environment: {
          worker_config: {
            memory_limit: 128,
            timeout: 30000,
            allowed_permissions: ["read"],
            isolation_level: "sandbox",
          },
          monitoring_config: {
            log_level: "info",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      },
    };

    worker.postMessage(openaiRequest);

    // Wait for execution result
    let openaiAttempts = 0;
    while (!executionResult && openaiAttempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      openaiAttempts++;
    }

    if (executionResult) {
      console.log("OpenAI worker result:", executionResult);
      expect(executionResult.success).toBe(true);
      expect(executionResult.output.provider).toBe("openai");
      expect(typeof executionResult.output.result).toBe("string");
    } else {
      console.warn("OpenAI test timed out - may need API key");
      throw new Error("OpenAI provider test failed - no response received");
    }

    // Reset for next test
    executionResult = null;

    // Test Google provider
    const googleRequest = {
      type: "execute",
      id: "test-google",
      data: {
        agent_id: "test-google-agent",
        agent_config: {
          type: "llm",
          model: "gemini-1.5-flash",
          parameters: {
            provider: "google",
            temperature: 0,
            max_tokens: 50,
          },
          prompts: {
            system: "You are a helpful assistant.",
          },
          tools: [],
        },
        task: {
          task: "Simple test",
          inputSource: "test",
        },
        input: "What is 4+4?",
        environment: {
          worker_config: {
            memory_limit: 128,
            timeout: 30000,
            allowed_permissions: ["read"],
            isolation_level: "sandbox",
          },
          monitoring_config: {
            log_level: "info",
            metrics_collection: true,
            safety_checks: ["memory_limit", "permissions"],
            output_validation: true,
          },
        },
      },
    };

    worker.postMessage(googleRequest);

    // Wait for execution result
    let googleAttempts = 0;
    while (!executionResult && googleAttempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      googleAttempts++;
    }

    if (executionResult) {
      console.log("Google worker result:", executionResult);
      expect(executionResult.success).toBe(true);
      expect(executionResult.output.provider).toBe("google");
      expect(typeof executionResult.output.result).toBe("string");
    } else {
      console.warn("Google test timed out - may need API key");
      throw new Error("Google provider test failed - no response received");
    }

    // Cleanup
    try {
      worker.terminate();
    } catch (error) {
      // Ignore cleanup errors
      console.warn("Worker termination error:", error);
    }
  },
  sanitizeResources: false,
  sanitizeOps: false,
});
