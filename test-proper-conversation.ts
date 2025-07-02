#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-kv --env-file

import { ConversationClient } from "./src/cli/utils/conversation-client.ts";

console.log("Testing proper conversation workflow...\n");

try {
  const client = new ConversationClient("http://localhost:8080", "test-workspace");

  // 1. Create session
  console.log("1. Creating session...");
  const session = await client.createSession({
    userId: "test-user",
    scope: { workspaceId: "test-workspace" },
    createOnly: true,
  });
  console.log("✓ Session created:", session.sessionId);

  // 2. Connect to SSE
  console.log("2. Setting up SSE listener...");
  const ssePromise = (async () => {
    let eventCount = 0;
    const events: any[] = [];

    for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
      eventCount++;
      console.log(`📡 Event ${eventCount}:`, {
        type: event.type,
        hasContent: !!event.data.content,
        complete: !!event.data.complete,
        partial: !!event.data.partial,
      });

      if (event.data.content && !event.data.partial) {
        console.log(`💬 Final response: "${event.data.content.substring(0, 100)}..."`);
      }

      if (event.type === "message_complete" || event.data.complete) {
        console.log("✓ Message complete received!");
        break;
      }

      // Safety valve
      if (eventCount > 50) {
        console.log("⚠️  Stopping after 50 events");
        break;
      }
    }

    return { eventCount, events };
  })();

  // 3. Send message using DaemonClient trigger
  console.log("3. Sending message via DaemonClient...");
  const messageResult = await client.sendMessage(
    session.sessionId,
    "Hello! This should work through the proper conversation workspace.",
  );
  console.log("✓ Message sent:", messageResult);

  // 4. Wait for response
  const result = await ssePromise;
  console.log(`\n🎉 Test completed! Received ${result.eventCount} events`);
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}
