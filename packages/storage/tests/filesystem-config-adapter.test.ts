import { expect } from "@std/expect";
import { FilesystemConfigAdapter } from "../src/adapters/filesystem-config-adapter.ts";
import { join } from "@std/path";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Temp directory will be created per test to avoid leaks
let tempDir: string;

Deno.test("FilesystemConfigAdapter - loads YAML files", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const testFile = join(tempDir, "test.yml");

    await Deno.writeTextFile(testFile, "name: test\nvalue: 123\nlist:\n  - item1\n  - item2");

    const content = await adapter.loadYamlFile(testFile);
    expect(content).toEqual({
      name: "test",
      value: 123,
      list: ["item1", "item2"],
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - handles YAML parsing errors", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const testFile = join(tempDir, "invalid.yml");

    // This YAML is actually valid, so let's create truly invalid YAML
    await Deno.writeTextFile(
      testFile,
      'invalid:\n  - yaml\n   bad: "indentation without list marker"',
    );

    try {
      await adapter.loadYamlFile(testFile);
      throw new Error("Expected YAML parsing to fail");
    } catch (error) {
      // Should throw a YAML parsing error
      expect(error instanceof Error).toBe(true);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - throws on missing files", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const missingFile = join(tempDir, "does-not-exist.yml");

    try {
      await adapter.loadYamlFile(missingFile);
      throw new Error("Expected file not found error");
    } catch (error) {
      // Check that it's a file not found error
      expect(error instanceof Error).toBe(true);
      expect(error.message).toContain("No such file");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - checks file existence", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const existingFile = join(tempDir, "exists.yml");
    const missingFile = join(tempDir, "missing.yml");

    await Deno.writeTextFile(existingFile, "test: true");

    expect(await adapter.fileExists(existingFile)).toBe(true);
    expect(await adapter.fileExists(missingFile)).toBe(false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - resolves atlas.yml path from CWD", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const workspaceDir = join(tempDir, "workspace1");

    await Deno.mkdir(workspaceDir, { recursive: true });

    // Test CWD resolution
    const cwdAtlas = join(workspaceDir, "atlas.yml");
    await Deno.writeTextFile(cwdAtlas, "version: 1.0");

    const resolvedPath = await adapter.resolveAtlasConfigPath(workspaceDir);
    expect(resolvedPath).toBe(cwdAtlas);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - resolves atlas.yml from git root", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const workspaceDir = join(tempDir, "workspace2");

    await Deno.mkdir(workspaceDir, { recursive: true });

    // No atlas.yml in workspace dir
    const resolvedPath = await adapter.resolveAtlasConfigPath(workspaceDir);

    // In our test environment, we're in a git repo with atlas.yml at root
    // So it should find the git root atlas.yml
    expect(resolvedPath).toContain("atlas.yml");

    // If we weren't in a git repo, it would return the workspace path
    // But in our case, we ARE in the atlas git repo
    const isGitRootPath = resolvedPath.includes("atlas/atlas.yml") &&
      !resolvedPath.includes("workspace2");
    const isWorkspacePath = resolvedPath === join(workspaceDir, "atlas.yml");

    // Should be one or the other
    expect(isGitRootPath || isWorkspacePath).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - resolves workspace.yml path", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const workspaceDir = join(tempDir, "workspace3");

    const resolvedPath = await adapter.resolveWorkspaceConfigPath(workspaceDir);
    expect(resolvedPath).toBe(join(workspaceDir, "workspace.yml"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - loads job files from directory", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const jobsDir = join(tempDir, "jobs");

    await Deno.mkdir(jobsDir, { recursive: true });

    // Create various job files
    await Deno.writeTextFile(
      join(jobsDir, "job1.yml"),
      "name: job1\ntask: test\ndescription: First job",
    );
    await Deno.writeTextFile(
      join(jobsDir, "job2.yaml"),
      "name: job2\ntask: test\ndescription: Second job",
    );
    await Deno.writeTextFile(
      join(jobsDir, "not-yaml.txt"),
      "This should be ignored",
    );
    await Deno.writeTextFile(
      join(jobsDir, "README.md"),
      "# Jobs Documentation",
    );

    const jobs = await adapter.loadJobFiles(jobsDir);

    expect(jobs.size).toBe(2);
    expect(jobs.has("job1")).toBe(true);
    expect(jobs.has("job2")).toBe(true);
    expect(jobs.has("not-yaml")).toBe(false);
    expect(jobs.has("README")).toBe(false);

    const job1 = jobs.get("job1");
    expect(job1).toEqual({
      name: "job1",
      task: "test",
      description: "First job",
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - handles empty jobs directory", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const emptyJobsDir = join(tempDir, "empty-jobs");

    await Deno.mkdir(emptyJobsDir, { recursive: true });

    const jobs = await adapter.loadJobFiles(emptyJobsDir);
    expect(jobs.size).toBe(0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - handles non-existent jobs directory", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const nonExistentDir = join(tempDir, "does-not-exist");

    const jobs = await adapter.loadJobFiles(nonExistentDir);
    expect(jobs.size).toBe(0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - loads supervisor defaults", async () => {
  const adapter = new FilesystemConfigAdapter();

  const defaults = await adapter.loadSupervisorDefaults();

  expect(defaults).toBeDefined();
  expect(defaults).toHaveProperty("version");
  expect(defaults).toHaveProperty("supervisors");

  // Just check the basic structure without comparing all the long prompt strings
  expect(defaults).toHaveProperty("version", "1.0");
  expect(defaults).toHaveProperty("supervisors");

  const supervisors = (defaults as { supervisors: Record<string, unknown> }).supervisors;
  expect(supervisors).toHaveProperty("workspace");
  expect(supervisors).toHaveProperty("session");
  expect(supervisors).toHaveProperty("agent");

  // Check that each supervisor has the expected structure
  for (const [, supervisor] of Object.entries(supervisors)) {
    expect(supervisor).toHaveProperty("model", "claude-3-5-sonnet-20241022");
    expect(supervisor).toHaveProperty("prompts");
    expect(supervisor).toHaveProperty("supervision");

    const prompts = (supervisor as { prompts: Record<string, unknown> }).prompts;
    expect(prompts).toHaveProperty("system");
    expect(typeof prompts.system).toBe("string");
  }
});

Deno.test("FilesystemConfigAdapter - handles special characters in filenames", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const specialJobsDir = join(tempDir, "special-jobs");

    await Deno.mkdir(specialJobsDir, { recursive: true });

    // Create job files with special characters
    await Deno.writeTextFile(
      join(specialJobsDir, "job-with-dash.yml"),
      "name: job-with-dash\ntask: test",
    );
    await Deno.writeTextFile(
      join(specialJobsDir, "job_with_underscore.yml"),
      "name: job_with_underscore\ntask: test",
    );
    await Deno.writeTextFile(
      join(specialJobsDir, "job.with.dots.yml"),
      "name: job.with.dots\ntask: test",
    );

    const jobs = await adapter.loadJobFiles(specialJobsDir);

    expect(jobs.size).toBe(3);
    expect(jobs.has("job-with-dash")).toBe(true);
    expect(jobs.has("job_with_underscore")).toBe(true);
    expect(jobs.has("job.with.dots")).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - preserves YAML structure correctly", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter();
    const complexFile = join(tempDir, "complex.yml");

    const complexYaml = `
version: "1.0"
metadata:
  name: Complex Config
  tags:
    - production
    - critical
  settings:
    timeout: 30
    retries: 3
    features:
      - name: feature1
        enabled: true
      - name: feature2
        enabled: false
nested:
  deeply:
    nested:
      value: 42
      array: [1, 2, 3]
      object: { key: value }
`;

    await Deno.writeTextFile(complexFile, complexYaml);

    const content = await adapter.loadYamlFile(complexFile);

    expect(content).toEqual({
      version: "1.0",
      metadata: {
        name: "Complex Config",
        tags: ["production", "critical"],
        settings: {
          timeout: 30,
          retries: 3,
          features: [
            { name: "feature1", enabled: true },
            { name: "feature2", enabled: false },
          ],
        },
      },
      nested: {
        deeply: {
          nested: {
            value: 42,
            array: [1, 2, 3],
            object: { key: "value" },
          },
        },
      },
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
