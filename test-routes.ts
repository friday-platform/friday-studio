#!/usr/bin/env deno run --allow-all
/**
 * Test script to check what routes and workspaces are available
 */

async function checkRoutes() {
  console.log("🔍 Checking daemon routes and workspaces...");

  try {
    // Check health
    const healthResponse = await fetch("http://localhost:8080/health");
    const healthData = await healthResponse.json();
    console.log("✅ Daemon health:", healthData);

    // Check available workspaces
    console.log("\n📋 Checking available workspaces...");
    const workspacesResponse = await fetch("http://localhost:8080/api/workspaces");
    if (workspacesResponse.ok) {
      const workspaces = await workspacesResponse.json();
      console.log(
        "Available workspaces:",
        workspaces.map((w: any) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          hasActiveRuntime: w.hasActiveRuntime,
        })),
      );
    } else {
      console.log("❌ Failed to fetch workspaces:", workspacesResponse.status);
    }

    // Test specific routes
    console.log("\n🛣️  Testing specific routes...");

    // Test the conversation route directly
    const routes = [
      "/system/conversation/stream",
      "/system/conversation/sessions/test/stream",
    ];

    for (const route of routes) {
      try {
        console.log(`Testing ${route}...`);
        const response = await fetch(`http://localhost:8080${route}`, {
          method: route.includes("/stream") && !route.includes("/sessions/") ? "POST" : "GET",
          headers: { "Content-Type": "application/json" },
          body: route.includes("/stream") && !route.includes("/sessions/")
            ? JSON.stringify({
              createOnly: true,
              userId: "test",
            })
            : undefined,
          signal: AbortSignal.timeout(2000),
        });

        console.log(`  ${route}: ${response.status} ${response.statusText}`);
        if (response.ok) {
          const data = await response.json();
          console.log(`  Response:`, data);
        }
      } catch (error) {
        console.log(`  ${route}: ERROR -`, error.message);
      }
    }
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

if (import.meta.main) {
  await checkRoutes();
}
