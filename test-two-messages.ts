#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

import { ConversationClient } from "./src/cli/utils/conversation-client.ts";

console.log("Testing two-message conversation...");

const client = new ConversationClient("http://localhost:8080", "test-workspace-001");

try {
  // Create session
  console.log("\n1. Creating conversation session...");
  const session = await client.createSession();
  console.log("✓ Session created:", session.sessionId);

  // Start persistent SSE stream
  console.log("\n2. Starting persistent SSE stream...");
  let eventCount = 0;
  let messagesCompleted = 0;

  // Start the persistent SSE listener
  const streamPromise = (async () => {
    for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
      eventCount++;
      console.log(`📡 Event ${eventCount}: ${event.type}`);

      if (event.type === "message_complete") {
        messagesCompleted++;
        console.log(`✓ Message ${messagesCompleted} completed`);

        // Exit after 2 completed messages
        if (messagesCompleted >= 2) {
          console.log("✓ Both messages completed successfully!");
          break;
        }
      }
    }
  })();

  // Send first message
  setTimeout(async () => {
    console.log("\n3. Sending first message...");
    await client.sendMessage(session.sessionId, "Hello!");
    console.log("✓ First message sent");
  }, 1000);

  // Send second message after first completes
  setTimeout(async () => {
    console.log("\n4. Sending second message...");
    await client.sendMessage(session.sessionId, "What is 2+2?");
    console.log("✓ Second message sent");
  }, 8000);

  // Wait for completion
  await streamPromise;
  console.log(`\n🎉 Success! Both messages completed. Total events: ${eventCount}`);
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}
