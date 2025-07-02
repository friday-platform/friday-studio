#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

import { ConversationClient } from "./src/cli/utils/conversation-client.ts";

console.log("Testing conversation system with session_reply tool...");

const client = new ConversationClient("http://localhost:8080", "test-workspace-001");

try {
  // Create session
  console.log("\n1. Creating conversation session...");
  const session = await client.createSession();
  console.log("✓ Session created:", {
    sessionId: session.sessionId,
    sseUrl: session.sseUrl,
  });

  // Start listening to SSE stream
  console.log("\n2. Starting SSE stream...");
  const streamPromise = (async () => {
    let eventCount = 0;
    const events: any[] = [];

    for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
      eventCount++;
      events.push(event);
      console.log(`📡 SSE Event ${eventCount}:`, {
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
      });

      // Stop after message complete
      if (event.type === "message_complete") {
        console.log("✓ Message complete received, stream will stay open");
        break;
      }
    }

    return { eventCount, events };
  })();

  // Send message after a short delay
  setTimeout(async () => {
    console.log("\n3. Sending message...");
    const messageResult = await client.sendMessage(
      session.sessionId,
      "Hello! Please reply using the session_reply tool.",
    );
    console.log("✓ Message sent:", messageResult);
  }, 1000);

  // Wait for stream completion
  const streamResult = await streamPromise;
  console.log(`\n✓ Stream completed with ${streamResult.eventCount} events`);

  console.log("\n🎉 Test completed successfully!");
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}
