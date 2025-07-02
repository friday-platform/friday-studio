#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

import { ConversationClient } from "./src/cli/utils/conversation-client.ts";

console.log("Simple stream test...\n");

try {
  const client = new ConversationClient("http://localhost:8080");

  // 1. Create session
  console.log("1. Creating session...");
  const session = await client.createSession({
    userId: "test-user",
    scope: { workspaceId: "test-workspace" },
    createOnly: true,
  });
  console.log("✓ Session created:", session.sessionId);

  // 2. Send message and wait for completion
  console.log("\n2. Sending message...");
  const messageResult = await client.sendMessage(
    session.sessionId,
    "Hello! Please reply using the stream_reply tool.",
  );
  console.log("✓ Message sent:", messageResult.messageId);

  // 3. Listen to events until completion
  console.log("\n3. Listening for response...");
  let eventCount = 0;
  let finalContent = "";

  for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
    eventCount++;
    console.log(
      `Event ${eventCount}: type=${event.type}, hasContent=${!!event.data
        .content}, complete=${!!event.data.complete}`,
    );

    if (event.data.content && !event.data.partial) {
      finalContent = event.data.content;
    }

    if (event.type === "message_complete" || event.data.complete) {
      console.log("✓ Completion event received!");
      break;
    }

    // Safety valve - stop after 100 events
    if (eventCount > 100) {
      console.log("⚠️  Stopping after 100 events");
      break;
    }
  }

  console.log(`\n🎉 Test completed! Received ${eventCount} events`);
  console.log(`Final response: "${finalContent.substring(0, 100)}..."`);
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}
