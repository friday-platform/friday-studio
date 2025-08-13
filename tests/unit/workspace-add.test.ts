import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { WorkspaceManager } from "@atlas/core";
import { AtlasClient } from "@atlas/client";

// Mock server for testing daemon endpoints
class MockDaemonServer {
  private server: Deno.HttpServer | null = null;
  private port = 0;
  private workspaces: Map<string, any> = new Map();
  private workspacesByPath: Map<string, any> = new Map();

  async start(): Promise<number> {
    this.port = 9000 + Math.floor(Math.random() * 1000);

    this.server = Deno.serve({ port: this.port }, async (req) => {
      const url = new URL(req.url);
      const method = req.method;

      // Handle /api/workspaces/add endpoint
      if (method === "POST" && url.pathname === "/api/workspaces/add") {
        const body = await req.json();
        const { path, name, description } = body;

        // Validate path
        if (!path) {
          return new Response(JSON.stringify({ error: "Path is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Check if workspace already exists at this path
        if (this.workspacesByPath.has(path)) {
          return new Response(
            JSON.stringify({ error: `Workspace already registered at path: ${path}` }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        // Check if name conflicts
        if (name) {
          const existingByName = Array.from(this.workspaces.values()).find(
            (w) => w.name === name,
          );
          if (existingByName) {
            return new Response(
              JSON.stringify({ error: `Workspace with name '${name}' already exists` }),
              {
                status: 409,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
        }

        // Create workspace entry
        const id = `ws_${Math.random().toString(36).substr(2, 9)}`;
        const workspace = {
          id,
          name: name || path.split("/").pop(),
          description,
          status: "stopped",
          path,
          createdAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        };

        this.workspaces.set(id, workspace);
        this.workspacesByPath.set(path, workspace);

        return new Response(JSON.stringify(workspace), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Handle /api/workspaces/add-batch endpoint
      if (method === "POST" && url.pathname === "/api/workspaces/add-batch") {
        const body = await req.json();
        const { paths } = body;

        if (!paths || !Array.isArray(paths) || paths.length === 0) {
          return new Response(JSON.stringify({ error: "Paths array is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const results = {
          added: [] as any[],
          failed: [] as any[],
        };

        for (const path of paths) {
          // Check if already exists
          if (this.workspacesByPath.has(path)) {
            results.failed.push({
              path,
              error: `Workspace already registered at path: ${path}`,
            });
            continue;
          }

          // Create workspace
          const id = `ws_${Math.random().toString(36).substr(2, 9)}`;
          const workspace = {
            id,
            name: path.split("/").pop(),
            status: "stopped",
            path,
            createdAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          };

          this.workspaces.set(id, workspace);
          this.workspacesByPath.set(path, workspace);
          results.added.push(workspace);
        }

        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Handle health check
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "healthy" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    });

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
    return this.port;
  }

  async stop() {
    if (this.server) {
      await this.server.shutdown();
    }
  }

  // Helper method to add a workspace directly (for testing conflicts)
  addWorkspace(path: string, name?: string) {
    const id = `ws_${Math.random().toString(36).substr(2, 9)}`;
    const workspace = {
      id,
      name: name || path.split("/").pop(),
      status: "stopped",
      path,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    this.workspaces.set(id, workspace);
    this.workspacesByPath.set(path, workspace);
    return workspace;
  }
}

Deno.test({
  name: "Workspace Add - Single workspace registration",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mockServer = new MockDaemonServer();
    const port = await mockServer.start();

    try {
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Test successful add
      const result = await client.addWorkspace({
        path: "/tmp/test-workspace",
        name: "My Test Workspace",
        description: "Test workspace description",
      });

      assertExists(result.id);
      assertEquals(result.name, "My Test Workspace");
      assertEquals(result.path, "/tmp/test-workspace");
    } finally {
      await mockServer.stop();
    }
  },
});

Deno.test({
  name: "Workspace Add - Duplicate path rejection",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mockServer = new MockDaemonServer();
    const port = await mockServer.start();

    try {
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Add a workspace first
      mockServer.addWorkspace("/tmp/existing-workspace");

      // Try to add at the same path
      await assertRejects(
        async () => {
          await client.addWorkspace({
            path: "/tmp/existing-workspace",
          });
        },
        Error,
        "Workspace already registered at path",
      );
    } finally {
      await mockServer.stop();
    }
  },
});

Deno.test({
  name: "Workspace Add - Duplicate name rejection",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mockServer = new MockDaemonServer();
    const port = await mockServer.start();

    try {
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Add a workspace with a specific name
      mockServer.addWorkspace("/tmp/workspace1", "unique-name");

      // Try to add another workspace with the same name
      await assertRejects(
        async () => {
          await client.addWorkspace({
            path: "/tmp/workspace2",
            name: "unique-name",
          });
        },
        Error,
        "Workspace with name 'unique-name' already exists",
      );
    } finally {
      await mockServer.stop();
    }
  },
});

Deno.test({
  name: "Workspace Add - Batch registration success",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mockServer = new MockDaemonServer();
    const port = await mockServer.start();

    try {
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      const result = await client.addWorkspaces({
        paths: ["/tmp/workspace1", "/tmp/workspace2", "/tmp/workspace3"],
      });

      assertEquals(result.added.length, 3);
      assertEquals(result.failed.length, 0);
      assertEquals(result.added[0].path, "/tmp/workspace1");
      assertEquals(result.added[1].path, "/tmp/workspace2");
      assertEquals(result.added[2].path, "/tmp/workspace3");
    } finally {
      await mockServer.stop();
    }
  },
});

Deno.test({
  name: "Workspace Add - Batch with partial failures",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mockServer = new MockDaemonServer();
    const port = await mockServer.start();

    try {
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      // Pre-register one workspace
      mockServer.addWorkspace("/tmp/existing");

      const result = await client.addWorkspaces({
        paths: ["/tmp/new1", "/tmp/existing", "/tmp/new2"],
      });

      assertEquals(result.added.length, 2);
      assertEquals(result.failed.length, 1);
      assertEquals(result.added[0].path, "/tmp/new1");
      assertEquals(result.added[1].path, "/tmp/new2");
      assertEquals(result.failed[0].path, "/tmp/existing");
      assertEquals(
        result.failed[0].error,
        "Workspace already registered at path: /tmp/existing",
      );
    } finally {
      await mockServer.stop();
    }
  },
});

Deno.test({
  name: "Workspace Add - Empty batch request validation",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mockServer = new MockDaemonServer();
    const port = await mockServer.start();

    try {
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      await assertRejects(
        async () => {
          await client.addWorkspaces({
            paths: [],
          });
        },
        Error,
        "Paths array is required",
      );
    } finally {
      await mockServer.stop();
    }
  },
});

Deno.test({
  name: "Workspace Add - Default name from path",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const mockServer = new MockDaemonServer();
    const port = await mockServer.start();

    try {
      const client = new AtlasClient({ url: `http://localhost:${port}` });

      const result = await client.addWorkspace({
        path: "/tmp/my-awesome-project",
      });

      assertEquals(result.name, "my-awesome-project");
    } finally {
      await mockServer.stop();
    }
  },
});
