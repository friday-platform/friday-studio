// Test the /api/stream/:streamId endpoint directly
console.log("Testing stream API endpoint...");

try {
  const response = await fetch("http://localhost:8080/api/stream/test-stream-123", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Hello from direct API test!",
      metadata: { test: true },
      conversationId: "test-conversation",
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  console.log("✅ Stream API response:", result);

  console.log("🎉 Stream API test completed successfully!");
} catch (error) {
  console.error("❌ Stream API test failed:", error);
}
