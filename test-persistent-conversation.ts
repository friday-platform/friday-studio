#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

import { ConversationClient } from "./src/cli/utils/conversation-client.ts";

console.log("Testing persistent conversation with single SSE connection...");

const client = new ConversationClient("http://localhost:8080", "test-workspace-001");

try {
  // Create session
  console.log("\n1. Creating conversation session...");
  const session = await client.createSession();
  console.log("✓ Session created:", {
    sessionId: session.sessionId,
    sseUrl: session.sseUrl,
  });

  // Start single persistent SSE stream
  console.log("\n2. Starting persistent SSE stream...");
  let totalEventCount = 0;
  let messagesCompleted = 0;
  const allEvents: any[] = [];

  // Start the persistent SSE listener
  const persistentStreamPromise = (async () => {
    for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
      totalEventCount++;
      allEvents.push(event);
      console.log(`📡 Event ${totalEventCount}:`, {
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
      });

      // Count completed messages but don't break - keep the stream open
      if (event.type === "message_complete") {
        messagesCompleted++;
        console.log(`✓ Message ${messagesCompleted} complete received, keeping stream open...`);

        // Exit after 3 completed messages
        if (messagesCompleted >= 3) {
          console.log("✓ All 3 messages completed, ending test");
          break;
        }
      }
    }
    return { totalEventCount, messagesCompleted, allEvents };
  })();

  // Send first message after a short delay
  setTimeout(async () => {
    console.log("\n3. Sending first message...");
    const messageResult = await client.sendMessage(
      session.sessionId,
      "Hello! Please reply using the stream_reply tool.",
    );
    console.log("✓ First message sent:", messageResult);
  }, 1000);

  // Send second message after first completes
  setTimeout(async () => {
    console.log("\n4. Sending second message...");
    const messageResult = await client.sendMessage(
      session.sessionId,
      "Great! Now tell me what 2+2 equals.",
    );
    console.log("✓ Second message sent:", messageResult);
  }, 8000); // Wait for first to complete

  // Send third message after second completes
  setTimeout(async () => {
    console.log("\n5. Sending third message...");
    const messageResult = await client.sendMessage(
      session.sessionId,
      "Do you remember what I asked you in my previous message?",
    );
    console.log("✓ Third message sent:", messageResult);
  }, 16000); // Wait for second to complete

  // Wait for all messages to complete
  const result = await persistentStreamPromise;

  console.log("\n🎉 Persistent conversation test completed successfully!");
  console.log(`Total events received: ${result.totalEventCount}`);
  console.log(`Messages completed: ${result.messagesCompleted}`);
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}
