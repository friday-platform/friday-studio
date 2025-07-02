#!/usr/bin/env deno run --allow-all
/**
 * Test script to isolate the message sending issue
 */

async function testMessageSending() {
  console.log("🔍 Testing message sending specifically...");

  try {
    // First create a session (this works)
    console.log("1️⃣ Creating session...");
    const createResponse = await fetch("http://localhost:8080/system/conversation/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        createOnly: true,
        userId: "test-user",
        scope: { workspaceId: "system" },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!createResponse.ok) {
      throw new Error(`Session creation failed: ${createResponse.status}`);
    }

    const createResult = await createResponse.json();
    console.log("✅ Session created:", createResult);

    // Now test message sending (this should fail/hang)
    console.log("\n2️⃣ Sending message...");
    const messageResponse = await fetch("http://localhost:8080/system/conversation/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        createOnly: false,
        message: "Hello, test message!",
        userId: "test-user",
        sessionId: createResult.session_id,
        scope: { workspaceId: "system" },
      }),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!messageResponse.ok) {
      const errorText = await messageResponse.text();
      throw new Error(`Message send failed: ${messageResponse.status} - ${errorText}`);
    }

    const messageResult = await messageResponse.json();
    console.log("✅ Message sent successfully:", messageResult);
  } catch (error) {
    console.error("❌ Test failed:", error);
    console.error("Error type:", error.constructor.name);
    if (error.name === "TimeoutError") {
      console.error("The request timed out - daemon is likely hanging in signal processing");
    }
  }
}

if (import.meta.main) {
  await testMessageSending();
}
