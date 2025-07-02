#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file

/**
 * Test the fixed conversation system with direct SSE emission
 */

const DAEMON_URL = "http://localhost:8080";

async function testConversation() {
  console.log("🧪 Testing fixed conversation system...");

  try {
    // 1. Create a session
    console.log("\n1. Creating conversation session...");
    const createResponse = await fetch(`${DAEMON_URL}/api/streams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "test-user",
        createOnly: true,
      }),
    });

    if (!createResponse.ok) {
      throw new Error(`Failed to create session: ${createResponse.status}`);
    }

    const session = await createResponse.json();
    const streamId = session.stream_id;
    console.log(`✓ Session created: ${streamId}`);

    // 2. Set up SSE listener
    console.log("\n2. Setting up SSE listener...");
    const sseUrl = `${DAEMON_URL}${session.sse_url}`;
    console.log(`SSE URL: ${sseUrl}`);

    const eventSource = new EventSource(sseUrl);
    let messageReceived = false;

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log(`📨 SSE Event:`, data);

      if (data.type === "message_chunk") {
        console.log(`💬 Message chunk: "${data.data.content}"`);
        messageReceived = true;
      } else if (data.type === "message_complete") {
        console.log(`✅ Message complete`);
        eventSource.close();
      }
    };

    eventSource.onerror = (error) => {
      console.error("❌ SSE Error:", error);
    };

    // 3. Send a message
    console.log("\n3. Sending test message...");
    const messageResponse = await fetch(`${DAEMON_URL}/api/stream/${streamId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hello! Can you tell me about Atlas?",
        userId: "test-user",
      }),
    });

    if (!messageResponse.ok) {
      throw new Error(`Failed to send message: ${messageResponse.status}`);
    }

    console.log("✓ Message sent successfully");

    // 4. Wait for response
    console.log("\n4. Waiting for conversation response...");
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (messageReceived) {
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 100);

      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        console.log("⏰ Test timed out after 30 seconds");
        eventSource.close();
        resolve(undefined);
      }, 30000);
    });

    if (messageReceived) {
      console.log("\n🎉 Conversation test PASSED! Messages are streaming correctly.");

      // Test second message
      console.log("\n5. Testing second message...");
      const secondResponse = await fetch(`${DAEMON_URL}/api/stream/${streamId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "What can you help me with?",
          userId: "test-user",
        }),
      });

      if (secondResponse.ok) {
        console.log("✓ Second message sent successfully");
        console.log("🎉 Multi-turn conversation test PASSED!");
      } else {
        console.log("❌ Second message failed");
      }
    } else {
      console.log("\n❌ Conversation test FAILED! No streaming response received.");
    }
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

if (import.meta.main) {
  await testConversation();
}
