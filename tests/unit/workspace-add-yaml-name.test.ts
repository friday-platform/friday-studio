/**
 * Unit tests for workspace add functionality that reads workspace name from workspace.yml
 */

import { AtlasClient } from "@atlas/client";
import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";

// Mock daemon server that simulates the workspace add endpoint
class MockDaemonServer {
  private port: number;
  private server: any;
  private workspaces: Map<string, any> = new Map();

  constructor(port: number) {
    this.port = port;
  }

  async start() {
    this.server = Deno.serve({ port: this.port }, async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/api/workspaces/add" && req.method === "POST") {
        const body = await req.json();
        const { path, name, description } = body;

        // Check if workspace already exists
        for (const [id, workspace] of this.workspaces) {
          if (workspace.path === path) {
            return new Response(
              JSON.stringify({ error: `Workspace already registered at path: ${path}` }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          if (name && workspace.name === name) {
            return new Response(
              JSON.stringify({ error: `Workspace with name '${name}' already exists` }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        // Simulate reading workspace.yml to get name
        let workspaceName = name;
        let workspaceDescription = description;

        if (!name) {
          try {
            const workspaceYmlPath = join(path, "workspace.yml");
            const yamlContent = await Deno.readTextFile(workspaceYmlPath);
            const lines = yamlContent.split("\n");

            // Simple parsing for test purposes
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i].trim();
              if (line === "workspace:") {
                // Look for name in next few lines
                for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                  const subLine = lines[j].trim();
                  if (subLine.startsWith("name:")) {
                    const nameMatch = subLine.match(/name:\s*["']?(.+?)["']?\s*$/);
                    if (nameMatch) {
                      workspaceName = nameMatch[1];
                    }
                  }
                  if (!description && subLine.startsWith("description:")) {
                    const descMatch = subLine.match(/description:\s*["']?(.+?)["']?\s*$/);
                    if (descMatch) {
                      workspaceDescription = descMatch[1];
                    }
                  }
                }
                break;
              }
            }
          } catch {
            // Fall back to directory name
            workspaceName = path.split("/").pop() || "workspace";
          }
        }

        // If still no name, use directory name
        if (!workspaceName) {
          workspaceName = path.split("/").pop() || "workspace";
        }

        const workspace = {
          id: `ws_${Date.now()}`,
          name: workspaceName,
          description: workspaceDescription,
          status: "inactive",
          path,
          createdAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        };

        this.workspaces.set(workspace.id, workspace);

        return new Response(JSON.stringify(workspace), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    });
  }

  async stop() {
    if (this.server) {
      await this.server.shutdown();
    }
  }
}

// Helper to create a test workspace with specific content
async function createTestWorkspaceWithConfig(
  basePath: string,
  dirName: string,
  workspaceConfig: string,
): Promise<string> {
  const workspacePath = join(basePath, dirName);
  await ensureDir(workspacePath);
  await Deno.writeTextFile(join(workspacePath, "workspace.yml"), workspaceConfig);
  return workspacePath;
}

Deno.test({
  name: "Workspace Add - Uses name from workspace.yml when no name provided",
  async fn() {
    const testDir = await Deno.makeTempDir({ prefix: "atlas-yaml-name-test-" });
    const port = 9000 + Math.floor(Math.random() * 1000);
    const daemon = new MockDaemonServer(port);

    try {
      await daemon.start();

      // Create workspace with name in YAML
      const workspaceYml = `
version: "1.0"

workspace:
  name: "Multi-Provider Telephone Game"
  description: "A game where messages transform through multiple agents"

signals:
  test-signal:
    provider: cli
`;

      const workspacePath = await createTestWorkspaceWithConfig(testDir, "telephone", workspaceYml);

      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspace({ path: workspacePath });

      // Should use name from workspace.yml, not directory name
      assertEquals(result.name, "Multi-Provider Telephone Game");
      assertEquals(result.description, "A game where messages transform through multiple agents");
    } finally {
      await daemon.stop();
      await Deno.remove(testDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Workspace Add - Provided name overrides workspace.yml name",
  async fn() {
    const testDir = await Deno.makeTempDir({ prefix: "atlas-yaml-override-test-" });
    const port = 9000 + Math.floor(Math.random() * 1000);
    const daemon = new MockDaemonServer(port);

    try {
      await daemon.start();

      // Create workspace with name in YAML
      const workspaceYml = `
workspace:
  name: "YAML Config Name"
  description: "YAML Config Description"
`;

      const workspacePath = await createTestWorkspaceWithConfig(
        testDir,
        "my-workspace",
        workspaceYml,
      );

      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspace({
        path: workspacePath,
        name: "Override Name",
        description: "Override Description",
      });

      // Should use provided name, not YAML name
      assertEquals(result.name, "Override Name");
      assertEquals(result.description, "Override Description");
    } finally {
      await daemon.stop();
      await Deno.remove(testDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Workspace Add - Falls back to directory name when no workspace name in YAML",
  async fn() {
    const testDir = await Deno.makeTempDir({ prefix: "atlas-yaml-fallback-test-" });
    const port = 9000 + Math.floor(Math.random() * 1000);
    const daemon = new MockDaemonServer(port);

    try {
      await daemon.start();

      // Create workspace without name in YAML
      const workspaceYml = `
workspace:
  description: "Just a description, no name"

signals:
  test-signal:
    provider: cli
`;

      const workspacePath = await createTestWorkspaceWithConfig(
        testDir,
        "fallback-dir-name",
        workspaceYml,
      );

      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspace({ path: workspacePath });

      // Should use directory name as fallback
      assertEquals(result.name, "fallback-dir-name");
      assertEquals(result.description, "Just a description, no name");
    } finally {
      await daemon.stop();
      await Deno.remove(testDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Workspace Add - Handles invalid YAML gracefully",
  async fn() {
    const testDir = await Deno.makeTempDir({ prefix: "atlas-yaml-invalid-test-" });
    const port = 9000 + Math.floor(Math.random() * 1000);
    const daemon = new MockDaemonServer(port);

    try {
      await daemon.start();

      // Create workspace with invalid YAML
      const workspaceYml = `
this is not: valid yaml
  - because it has
    inconsistent: indentation
      and: problems
`;

      const workspacePath = await createTestWorkspaceWithConfig(
        testDir,
        "invalid-yaml-dir",
        workspaceYml,
      );

      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspace({ path: workspacePath });

      // Should fall back to directory name when YAML parsing fails
      assertEquals(result.name, "invalid-yaml-dir");
    } finally {
      await daemon.stop();
      await Deno.remove(testDir, { recursive: true });
    }
  },
});
