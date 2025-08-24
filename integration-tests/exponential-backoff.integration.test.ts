import { assertEquals } from "@std/assert";
import { isOverloadError, withExponentialBackoff } from "../src/utils/exponential-backoff.ts";

/**
 * Integration test demonstrating the ConversationAgent use case
 */
Deno.test("ConversationAgent overload scenario", async () => {
  // Simulate Anthropic API behavior
  let callCount = 0;
  const maxFailures = 3;
  const streamUpdates: string[] = [];

  // Mock the atlas_stream_event tool
  const mockStreamEvent = {
    execute: (params: { eventType: string; content: string }) => {
      if (params.eventType === "thinking") {
        streamUpdates.push(params.content);
      }
      return Promise.resolve();
    },
  };

  // Simulate the streamText function that might fail with overload
  const mockStreamText = () => {
    callCount++;
    if (callCount <= maxFailures) {
      // Simulate Anthropic overload error
      const error = new Error("Overloaded");
      (error as { type?: string }).type = "overloaded_error";
      throw error;
    }

    // Simulate successful streaming
    return {
      fullStream: (async function* () {
        yield { type: "text", content: "Hello" };
        yield { type: "text", content: " world!" };
      })(),
      text: Promise.resolve("Hello world!"),
      reasoning: Promise.resolve(["Thinking about the response"]),
    };
  };

  // Run the retry logic similar to ConversationAgent
  const result = await withExponentialBackoff(
    async () => {
      const { fullStream, text, reasoning } = await mockStreamText();

      // Process the stream
      let responseBuffer = "";
      for await (const chunk of fullStream) {
        if (chunk.type === "text") {
          responseBuffer += chunk.content;
        }
      }

      const finalText = await text;
      const finalReasoning = await reasoning;

      return { text: finalText, reasoning: finalReasoning, responseBuffer };
    },
    {
      maxRetries: 10,
      initialDelay: 10, // Fast for testing
      maxDelay: 100,
      onRetry: async (attempt: number, delay: number) => {
        await mockStreamEvent.execute({
          eventType: "thinking",
          content: `Retrying (attempt ${attempt}/10)... waiting ${delay / 1000}s`,
        });
      },
      isRetryable: isOverloadError,
    },
  );

  // Verify results
  assertEquals(result.text, "Hello world!");
  assertEquals(result.responseBuffer, "Hello world!");
  assertEquals(result.reasoning, ["Thinking about the response"]);
  assertEquals(callCount, maxFailures + 1); // 3 failures + 1 success

  // Verify retry messages were sent to user
  assertEquals(streamUpdates.length, maxFailures);
  assertEquals(streamUpdates[0], "Retrying (attempt 1/10)... waiting 0.01s");
  assertEquals(streamUpdates[1], "Retrying (attempt 2/10)... waiting 0.02s");
  assertEquals(streamUpdates[2], "Retrying (attempt 3/10)... waiting 0.04s");
});

Deno.test("ConversationAgent - all retries exhausted scenario", async () => {
  let callCount = 0;
  const errorMessages: Array<{ type: string; content: string }> = [];

  // Mock the atlas_stream_event tool
  const mockStreamEvent = {
    execute: (params: { eventType: string; content: string }) => {
      errorMessages.push({ type: params.eventType, content: params.content });
      return Promise.resolve();
    },
  };

  // Always fail with overload
  const mockStreamText = () => {
    callCount++;
    throw { type: "overloaded_error", message: "Overloaded" };
  };

  try {
    await withExponentialBackoff(
      async () => {
        await mockStreamText();
        return { text: "This won't happen" };
      },
      {
        maxRetries: 3, // Fewer retries for faster test
        initialDelay: 10,
        onRetry: async (attempt: number, delay: number) => {
          await mockStreamEvent.execute({
            eventType: "thinking",
            content: `Retrying (attempt ${attempt}/3)... waiting ${delay / 1000}s`,
          });
        },
        isRetryable: isOverloadError,
      },
    );

    // Should not reach here
    throw new Error("Expected function to throw");
  } catch (error) {
    // Verify the error was thrown after exhausting retries
    assertEquals((error as { type?: string }).type, "overloaded_error");
    assertEquals(callCount, 4); // Initial + 3 retries

    // In real ConversationAgent, this is where we'd send the final error message
    await mockStreamEvent.execute({
      eventType: "error",
      content:
        "I'm experiencing high demand. I tried 3 times but couldn't process your request. Please try again later.",
    });
  }

  // Verify retry messages
  assertEquals(errorMessages.length, 4); // 3 retries + 1 final error
  assertEquals(errorMessages[0], {
    type: "thinking",
    content: "Retrying (attempt 1/3)... waiting 0.01s",
  });
  assertEquals(errorMessages[3], {
    type: "error",
    content:
      "I'm experiencing high demand. I tried 3 times but couldn't process your request. Please try again later.",
  });
});
