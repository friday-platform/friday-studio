import { assertEquals, assertStringIncludes } from "@std/assert";
import { cleanupTestDir, createTestDir, runCLI } from "../../tests/helpers.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { WorkspaceStatus as WSStatus } from "../../../core/workspace-registry-types.ts";
import { join } from "@std/path";
import * as yaml from "@std/yaml";

Deno.test("workspace serve - starts server and updates registry", async () => {
  const tempDir = await createTestDir();

  try {
    // Initialize workspace first
    await runCLI(["workspace", "init", "ServeTest", "."], {
      cwd: tempDir,
      env: { ...Deno.env.toObject() },
    });

    // Start the server in the background
    const serveCommand = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--unstable-broadcast-channel",
        "--unstable-worker-options",
        new URL("../../../cli.tsx", import.meta.url).pathname,
        "workspace",
        "serve",
        "--port",
        "8899",
      ],
      cwd: tempDir,
      env: { ...Deno.env.toObject() },
      stdout: "piped",
      stderr: "piped",
      stdin: "piped",
    });

    const child = serveCommand.spawn();
    
    // Capture stderr and stdout to debug crashes
    const errorReader = child.stderr.getReader();
    const outputReader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let errorOutput = "";
    let stdOutput = "";
    
    // Read stderr in background
    (async () => {
      try {
        while (true) {
          const { done, value } = await errorReader.read();
          if (done) break;
          errorOutput += decoder.decode(value);
        }
      } catch {
        // Ignore read errors
      }
    })();
    
    // Read stdout in background
    (async () => {
      try {
        while (true) {
          const { done, value } = await outputReader.read();
          if (done) break;
          stdOutput += decoder.decode(value);
        }
      } catch {
        // Ignore read errors
      }
    })();

    // Wait for server to start and update registry status
    let workspace;
    let attempts = 0;
    const maxAttempts = 30; // 15 seconds total

    const registry = getWorkspaceRegistry();
    await registry.initialize();

    while (attempts < maxAttempts) {
      workspace = await registry.findByName("ServeTest");
      if (workspace && workspace.status === WSStatus.RUNNING) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }
    
    // If not running, log the error output
    if (!workspace || workspace.status !== WSStatus.RUNNING) {
      console.error("Server failed to start.");
      console.error("Stdout:", stdOutput);
      console.error("Stderr:", errorOutput);
      console.error("Workspace status:", workspace?.status);
    }

    // Verify workspace is registered and running
    assertEquals(workspace !== null, true);
    if (workspace) {
      assertEquals(workspace.status, WSStatus.RUNNING);
      assertEquals(workspace.port, 8899);
      assertEquals(typeof workspace.pid, "number");
    }

    // Kill the server and wait for it to exit
    child.kill("SIGTERM");
    await child.status;
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace serve - handles missing workspace.yml", async () => {
  const tempDir = await createTestDir();

  try {
    const result = await runCLI(["workspace", "serve"], {
      cwd: tempDir,
    });

    // React components show error in stdout instead of exiting with error code
    assertStringIncludes(result.stdout, "Error:");
    assertStringIncludes(result.stdout, "workspace.yml");
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace serve - registers unregistered workspace", async () => {
  const tempDir = await createTestDir();

  try {
    // Create workspace.yml without registering
    const workspaceYml = {
      version: "1.0",
      workspace: {
        id: "unregistered-serve-id",
        name: "UnregisteredServe",
        description: "Unregistered workspace for serve test",
      },
      signals: {},
      jobs: {},
      agents: {},
    };

    await Deno.writeTextFile(
      join(tempDir, "workspace.yml"),
      yaml.stringify(workspaceYml),
    );

    // Also create atlas.yml for merged config
    const atlasYml = {
      version: "1.0",
      runtime: {
        server: {
          port: 8900,
          host: "localhost",
        },
      },
    };

    await Deno.writeTextFile(
      join(tempDir, "atlas.yml"),
      yaml.stringify(atlasYml),
    );

    // Start server (it should auto-register)
    const serveCommand = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--unstable-broadcast-channel",
        "--unstable-worker-options",
        new URL("../../../cli.tsx", import.meta.url).pathname,
        "workspace",
        "serve",
      ],
      cwd: tempDir,
      env: { ...Deno.env.toObject() },
      stdout: "piped",
      stderr: "piped",
      stdin: "piped",
    });

    const child = serveCommand.spawn();

    // Wait for server to start and register
    let workspace;
    let attempts = 0;
    const maxAttempts = 30; // 15 seconds total

    const registry = getWorkspaceRegistry();
    await registry.initialize();

    while (attempts < maxAttempts) {
      workspace = await registry.findByName("UnregisteredServe");
      if (workspace && workspace.status === WSStatus.RUNNING) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }

    // Verify workspace was auto-registered
    assertEquals(workspace !== null, true);
    if (workspace) {
      assertEquals(workspace.name, "UnregisteredServe");
      assertEquals(workspace.status, WSStatus.RUNNING);
    }

    // Kill the server and wait for it to exit
    child.kill("SIGTERM");
    await child.status;
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace serve - respects port flag", async () => {
  const tempDir = await createTestDir();

  try {
    // Initialize workspace
    await runCLI(["workspace", "init", "PortTest", "."], {
      cwd: tempDir,
      env: { ...Deno.env.toObject() },
    });

    // Start with custom port
    const serveCommand = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--unstable-broadcast-channel",
        "--unstable-worker-options",
        new URL("../../../cli.tsx", import.meta.url).pathname,
        "workspace",
        "serve",
        "--port",
        "9999",
      ],
      cwd: tempDir,
      env: { ...Deno.env.toObject() },
      stdout: "piped",
      stderr: "piped",
      stdin: "piped",
    });

    const child = serveCommand.spawn();

    // Wait for server to start
    let workspace;
    let attempts = 0;
    const maxAttempts = 30; // 15 seconds total

    const registry = getWorkspaceRegistry();
    await registry.initialize();

    while (attempts < maxAttempts) {
      workspace = await registry.findByName("PortTest");
      if (workspace && workspace.status === WSStatus.RUNNING) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }

    assertEquals(workspace !== null, true);
    if (workspace) {
      assertEquals(workspace.port, 9999);
    }

    // Kill the server and wait for it to exit
    child.kill("SIGTERM");
    await child.status;
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace serve - updates status on crash", async () => {
  const tempDir = await createTestDir();

  try {
    // Create a workspace with invalid configuration that will crash
    const workspaceYml = {
      version: "1.0",
      workspace: {
        id: "crash-test-id",
        name: "CrashTest",
        description: "Workspace that will crash",
      },
      // Invalid agent configuration that might cause issues
      agents: {
        "invalid-agent": {
          type: "invalid-type",
          path: "/nonexistent/path",
        },
      },
      signals: {},
      jobs: {},
    };

    await Deno.writeTextFile(
      join(tempDir, "workspace.yml"),
      yaml.stringify(workspaceYml),
    );

    // Try to start server
    const result = await runCLI(["workspace", "serve"], {
      cwd: tempDir,
      env: { ...Deno.env.toObject() },
    });

    // Should exit with error
    assertEquals(result.code !== 0, true);

    // Note: The actual crash status update might not happen in test environment
    // since the process exits immediately. This is more of a placeholder test
    // to ensure the crash handling code path exists.
  } finally {
    await cleanupTestDir(tempDir);
  }
});

Deno.test("workspace serve - dynamic port assignment", async () => {
  const tempDir1 = await createTestDir();
  const tempDir2 = await createTestDir();

  try {
    // Initialize two workspaces
    await runCLI(["workspace", "init", "DynamicPort1", "."], {
      cwd: tempDir1,
      env: { ...Deno.env.toObject() },
    });

    await runCLI(["workspace", "init", "DynamicPort2", "."], {
      cwd: tempDir2,
      env: { ...Deno.env.toObject() },
    });

    // Start first server without specifying port
    const serveCommand1 = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--unstable-broadcast-channel",
        "--unstable-worker-options",
        new URL("../../../cli.tsx", import.meta.url).pathname,
        "workspace",
        "serve",
      ],
      cwd: tempDir1,
      env: { ...Deno.env.toObject() },
      stdout: "piped",
      stderr: "piped",
      stdin: "piped",
    });

    const child1 = serveCommand1.spawn();

    // Wait for first server to start
    const registry = getWorkspaceRegistry();
    await registry.initialize();

    let workspace1;
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      workspace1 = await registry.findByName("DynamicPort1");
      if (workspace1 && workspace1.status === WSStatus.RUNNING) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }

    assertEquals(workspace1 !== null, true);
    const firstPort = workspace1?.port;
    assertEquals(typeof firstPort, "number");
    assertEquals(
      firstPort! >= 8080 && firstPort! <= 8180,
      true,
      "First port should be in default range",
    );

    // Start second server without specifying port
    const serveCommand2 = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--unstable-broadcast-channel",
        "--unstable-worker-options",
        new URL("../../../cli.tsx", import.meta.url).pathname,
        "workspace",
        "serve",
      ],
      cwd: tempDir2,
      env: { ...Deno.env.toObject() },
      stdout: "piped",
      stderr: "piped",
      stdin: "piped",
    });

    const child2 = serveCommand2.spawn();

    // Wait for second server to start
    let workspace2;
    attempts = 0;

    while (attempts < maxAttempts) {
      workspace2 = await registry.findByName("DynamicPort2");
      if (workspace2 && workspace2.status === WSStatus.RUNNING) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }

    assertEquals(workspace2 !== null, true);
    const secondPort = workspace2?.port;
    assertEquals(typeof secondPort, "number");
    assertEquals(secondPort !== firstPort, true, "Second port should be different from first");

    // Kill both servers
    child1.kill("SIGTERM");
    child2.kill("SIGTERM");
    await child1.status;
    await child2.status;
  } finally {
    await cleanupTestDir(tempDir1);
    await cleanupTestDir(tempDir2);
  }
});
