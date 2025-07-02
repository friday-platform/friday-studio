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

  // Send first message after a short delay
  setTimeout(async () => {
    console.log("\n3. Sending first message...");
    const messageResult = await client.sendMessage(
      session.sessionId,
      "Hello! Please reply using the stream_reply tool.",
    );
    console.log("✓ First message sent:", messageResult);
  }, 1000);

  // Wait for first response
  const firstStreamResult = await streamPromise;
  console.log(`\n✓ First response completed with ${firstStreamResult.eventCount} events`);

  // Send second message to test multi-turn
  console.log("\n4. Testing multi-turn conversation...");
  const secondStreamPromise = (async () => {
    let eventCount = 0;
    const events: any[] = [];

    for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
      eventCount++;
      events.push(event);
      console.log(`📡 Turn 2 Event ${eventCount}:`, {
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
      });

      // Stop after message complete
      if (event.type === "message_complete") {
        console.log("✓ Second message complete received");
        break;
      }
    }

    return { eventCount, events };
  })();

  // Send second message
  setTimeout(async () => {
    console.log("\n5. Sending second message...");
    const messageResult = await client.sendMessage(
      session.sessionId,
      "Great! Now tell me what 2+2 equals.",
    );
    console.log("✓ Second message sent:", messageResult);
  }, 2000);

  // Wait for second response
  const secondStreamResult = await secondStreamPromise;
  console.log(`\n✓ Second response completed with ${secondStreamResult.eventCount} events`);

  // Send third message to test conversation continuity
  console.log("\n6. Testing conversation continuity...");
  const thirdStreamPromise = (async () => {
    let eventCount = 0;
    const events: any[] = [];

    for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
      eventCount++;
      events.push(event);
      console.log(`📡 Turn 3 Event ${eventCount}:`, {
        type: event.type,
        timestamp: event.timestamp,
        data: event.data,
      });

      // Stop after message complete
      if (event.type === "message_complete") {
        console.log("✓ Third message complete received");
        break;
      }
    }

    return { eventCount, events };
  })();

  // Send third message
  setTimeout(async () => {
    console.log("\n7. Sending third message...");
    const messageResult = await client.sendMessage(
      session.sessionId,
      "Do you remember what I asked you in my previous message?",
    );
    console.log("✓ Third message sent:", messageResult);
  }, 4000);

  // Wait for third response
  const thirdStreamResult = await thirdStreamPromise;
  console.log(`\n✓ Third response completed with ${thirdStreamResult.eventCount} events`);

  console.log("\n🎉 Multi-turn conversation test completed successfully!");
  console.log(
    `Total events: Turn 1: ${firstStreamResult.eventCount}, Turn 2: ${secondStreamResult.eventCount}, Turn 3: ${thirdStreamResult.eventCount}`,
  );
} catch (error) {
  console.error("❌ Test failed:", error);
  Deno.exit(1);
}
