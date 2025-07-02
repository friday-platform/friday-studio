#!/usr/bin/env -S deno run --allow-all

import { ConversationClient } from "../src/cli/utils/conversation-client.ts";

const daemonUrl = "http://localhost:8080";
const workspaceId = "default-workspace"; // Use an existing workspace

async function testCxReply() {
  console.log("Testing cx_reply fix...");

  // First check daemon status directly
  try {
    const statusResponse = await fetch(`${daemonUrl}/api/daemon/status`);
    if (statusResponse.ok) {
      const status = await statusResponse.json();
      console.log("✅ Daemon is running:", status);
    } else {
      console.error("❌ Daemon status check failed:", statusResponse.status);
    }
  } catch (error) {
    console.error("❌ Cannot reach daemon:", error);
  }

  const client = new ConversationClient(daemonUrl, workspaceId, "test-script");

  // Health check
  const isHealthy = await client.healthCheck();
  if (!isHealthy) {
    console.error("❌ Atlas daemon health check failed - checking if /health endpoint exists...");

    // Try the actual health endpoint
    try {
      const healthResponse = await fetch(`${daemonUrl}/health`);
      console.log("Health endpoint status:", healthResponse.status);
    } catch (error) {
      console.error("Health endpoint error:", error);
    }

    // Continue anyway for testing
    console.log("⚠️ Continuing with test despite health check failure...");
  }

  // Create session
  const session = await client.createSession();
  console.log(`✅ Session created: ${session.sessionId}`);

  // Send test message
  const testMessage =
    "Send me a message in Discord any time Nike adds a new upcoming shoe drop to https://www.nike.com/w/new-upcoming-drops-k0gk. Include an image, price, description, and link, and use AI to rate the hype level or suggest a resale value.";

  // Listen for events BEFORE sending message to avoid race condition
  console.log("\n📥 Starting event listener...");
  let messageReceived = false;
  let toolCallsReceived = false;

  // Start listening in the background
  const eventPromise = (async () => {
    for await (const event of client.streamEvents(session.sessionId)) {
      console.log(`\n[${event.type}]`, JSON.stringify(event.data, null, 2));

      if (event.type === "tool_call") {
        toolCallsReceived = true;
        console.log("✅ Tool call received:", event.data.toolName);
      }

      if (event.type === "message_chunk" && event.data.content) {
        messageReceived = true;
        console.log("✅ Message chunk received, content length:", event.data.content.length);
      }

      if (event.type === "message_complete") {
        if (event.data.error) {
          console.error("❌ Error:", event.data.error);
        } else {
          console.log("\n✅ Message complete");
          console.log("Tool calls received:", toolCallsReceived);
          console.log("Message received:", messageReceived);

          if (!messageReceived) {
            console.error("❌ No message content was received!");
          }
        }
        break;
      }
    }
  })();

  // Give SSE connection time to establish
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Now send the message
  console.log("\n📤 Sending message:", testMessage);
  await client.sendMessage(session.sessionId, testMessage);

  const timeout = setTimeout(() => {
    if (!messageReceived) {
      console.error("\n❌ TIMEOUT: No message received after 30 seconds");
      Deno.exit(1);
    }
  }, 30000);

  // Wait for the event promise to complete
  await eventPromise;
  clearTimeout(timeout);

  console.log("\n✅ Test complete");
}

// Run the test
testCxReply().catch(console.error);
