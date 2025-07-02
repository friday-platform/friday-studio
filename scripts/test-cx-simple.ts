#!/usr/bin/env -S deno run --allow-all

import { ConversationClient } from "../src/cli/utils/conversation-client.ts";

const daemonUrl = "http://localhost:8080";
const workspaceId = "default-workspace";

async function testSimpleMessage() {
  console.log("Testing simple cx_reply...");

  const client = new ConversationClient(daemonUrl, workspaceId, "test-script");

  // Check daemon status
  try {
    const statusResponse = await fetch(`${daemonUrl}/api/daemon/status`);
    const status = await statusResponse.json();
    console.log("✅ Daemon is running:", status);
  } catch (error) {
    console.error("❌ Cannot reach daemon:", error);
    return;
  }

  // Create session
  const session = await client.createSession();
  console.log(`✅ Session created: ${session.sessionId}`);

  // Simple test message that should just trigger cx_reply
  const testMessage = "What is Atlas?";

  console.log("\n📥 Starting event listener...");
  let messageReceived = false;
  let messageContent = "";

  // Start listening in the background
  const eventPromise = (async () => {
    for await (const event of client.streamEvents(session.sessionId)) {
      console.log(`\n[${event.type}]`, JSON.stringify(event.data, null, 2));

      if (event.type === "message_chunk" && event.data.content) {
        messageReceived = true;
        messageContent = event.data.content;
        console.log("✅ Message chunk received, content length:", event.data.content.length);
      }

      if (event.type === "message_complete") {
        if (event.data.error) {
          console.error("❌ Error:", event.data.error);
        } else {
          console.log("\n✅ Message complete");
          console.log("Message received:", messageReceived);
          if (messageReceived) {
            console.log("\n📨 Final message:");
            console.log(messageContent);
          }
        }
        break;
      }
    }
  })();

  // Give SSE connection time to establish
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Now send the message
  console.log(`\n📤 Sending message: "${testMessage}"`);
  await client.sendMessage(session.sessionId, testMessage);

  // Wait up to 60 seconds for a response
  const timeout = setTimeout(() => {
    if (!messageReceived) {
      console.error("\n❌ TIMEOUT: No message received after 60 seconds");
      Deno.exit(1);
    }
  }, 60000);

  await eventPromise;
  clearTimeout(timeout);

  console.log("\n✅ Test complete");
}

// Run the test
testSimpleMessage().catch(console.error);
