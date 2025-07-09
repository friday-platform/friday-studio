import { assertEquals, assertExists } from "@std/assert";
import { createAtlasClient } from "../mod.ts";
import { AtlasDaemon } from "@atlas/atlasd";

Deno.test({
  name: "Integration test - health check with real Atlas daemon",
  // Disable sanitizers since the daemon opens databases and files
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Start real Atlas daemon on a specific test port
    const testPort = 8765;
    const daemon = new AtlasDaemon({ port: testPort });
    const serverPromise = daemon.startNonBlocking();
    const { finished } = await serverPromise;

    try {
      // Create client pointing to real daemon
      const client = createAtlasClient({ baseUrl: `http://localhost:${testPort}` });

      // Make health check request
      const { data, error } = await client.GET("/health");

      // Verify no error
      assertEquals(error, undefined);
      assertExists(data);

      // Verify response data types and values
      assertEquals(data.activeWorkspaces, 0); // Should be 0 on fresh daemon

      assertExists(data.uptime >= 0);

      // Verify it's a valid ISO date
      const timestamp = new Date(data.timestamp);
      assertExists(timestamp);
      assertEquals(timestamp.toISOString(), data.timestamp);

      assertExists(data.version);
      assertEquals(data.version.deno, Deno.version.deno);
      assertEquals(data.version.v8, Deno.version.v8);
      assertEquals(data.version.typescript, Deno.version.typescript);
    } finally {
      // Clean up
      await daemon.shutdown();
      await finished;
    }
  },
});

Deno.test("Integration test - verify typed client provides autocomplete", () => {
  // This is a compile-time test to ensure TypeScript types work
  const client = createAtlasClient();

  // These should compile without errors
  assertEquals(typeof client.GET, "function");
  assertEquals(typeof client.POST, "function");
  assertEquals(typeof client.PUT, "function");
  assertEquals(typeof client.DELETE, "function");
  assertEquals(typeof client.PATCH, "function");

  // The client should have proper typing for available endpoints
  // This test passes if it compiles - the actual method calls would fail
  // since we're not running against a real server here
});
