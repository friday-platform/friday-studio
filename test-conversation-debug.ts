#!/usr/bin/env deno run --allow-all --unstable-kv
/**
 * Test script to debug conversation client issues
 */

import { ConversationClient } from "./src/cli/utils/conversation-client.ts";

async function testConversationClient() {
  console.log("🔍 Starting conversation client debug test...");

  try {
    // Test daemon health first
    console.log("📡 Testing daemon health...");
    const healthResponse = await fetch("http://localhost:8080/health");
    if (!healthResponse.ok) {
      throw new Error(`Daemon health check failed: ${healthResponse.status}`);
    }
    const healthData = await healthResponse.json();
    console.log("✅ Daemon is healthy:", healthData);

    // Initialize conversation client
    console.log("🎭 Initializing ConversationClient...");
    const client = new ConversationClient(
      "http://localhost:8080",
      "system", // Use system workspace for conversation
      "test-user",
    );

    // Create session
    console.log("🔗 Creating conversation session...");
    const session = await client.createSession();
    console.log("✅ Session created:", {
      sessionId: session.sessionId,
      sseUrl: session.sseUrl,
      mode: session.mode,
    });

    // Send a test message
    console.log("💬 Sending test message...");
    const messageResult = await client.sendMessage(session.sessionId, "Hello, this is a test!");
    console.log("📤 Message sent:", messageResult);

    // Start listening for events
    console.log("👂 Starting to listen for events...");
    const eventPromise = new Promise(async (resolve, reject) => {
      try {
        let eventCount = 0;
        const timeout = setTimeout(() => {
          reject(new Error("Timeout: No events received within 10 seconds"));
        }, 10000);

        for await (const event of client.streamEvents(session.sessionId, session.sseUrl)) {
          eventCount++;
          console.log(`📨 Event ${eventCount}:`, {
            type: event.type,
            data: event.data,
            timestamp: event.timestamp,
            sessionId: event.sessionId,
          });

          if (event.type === "message_complete") {
            clearTimeout(timeout);
            console.log("✅ Conversation completed successfully!");
            resolve(event);
            break;
          }

          if (eventCount > 20) {
            clearTimeout(timeout);
            console.log("⚠️  Stopping after 20 events");
            resolve(event);
            break;
          }
        }
      } catch (error) {
        reject(error);
      }
    });

    await eventPromise;
  } catch (error) {
    console.error("❌ Test failed:", error);
    console.error("Stack:", error instanceof Error ? error.stack : "No stack trace");

    // Additional debugging
    console.log("\n🔍 Additional debugging info:");
    try {
      const response = await fetch("http://localhost:8080/api/workspaces");
      const workspaces = await response.json();
      console.log(
        "Available workspaces:",
        workspaces.map((w: any) => ({ id: w.id, name: w.name })),
      );
    } catch (wsError) {
      console.log("Failed to fetch workspaces:", wsError);
    }

    Deno.exit(1);
  }
}

// Check if daemon is running, if not, provide helpful message
async function checkDaemon() {
  try {
    const response = await fetch("http://localhost:8080/health", {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  console.log("🚀 Conversation Client Debug Test");
  console.log("================================");

  const daemonRunning = await checkDaemon();
  if (!daemonRunning) {
    console.error("❌ Atlas daemon not running on localhost:8080");
    console.log("💡 Start the daemon first with: deno task daemon:start");
    Deno.exit(1);
  }

  await testConversationClient();
}
