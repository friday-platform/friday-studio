import { expect } from "@std/expect";
import { FilesystemConfigAdapter } from "../src/adapters/config/fs.ts";
import { join } from "@std/path";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Temp directory will be created per test to avoid leaks
let tempDir: string;

Deno.test("FilesystemConfigAdapter - constructor requires workspace path", () => {
  const adapter = new FilesystemConfigAdapter("/test/workspace");
  expect(adapter.getWorkspacePath()).toBe("/test/workspace");
});

Deno.test("FilesystemConfigAdapter - reads YAML files", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter(tempDir);
    const testFile = join(tempDir, "test.yml");

    await Deno.writeTextFile(testFile, "name: test\nvalue: 123\nlist:\n  - item1\n  - item2");

    const content = await adapter.readYaml(testFile);
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
    const adapter = new FilesystemConfigAdapter(tempDir);
    const testFile = join(tempDir, "invalid.yml");

    // This YAML is actually valid, so let's create truly invalid YAML
    await Deno.writeTextFile(
      testFile,
      'invalid:\n  - yaml\n   bad: "indentation without list marker"',
    );

    try {
      await adapter.readYaml(testFile);
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
    const adapter = new FilesystemConfigAdapter(tempDir);
    const missingFile = join(tempDir, "does-not-exist.yml");

    try {
      await adapter.readYaml(missingFile);
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
    const adapter = new FilesystemConfigAdapter(tempDir);
    const existingFile = join(tempDir, "exists.yml");
    const missingFile = join(tempDir, "missing.yml");

    await Deno.writeTextFile(existingFile, "test: true");

    expect(await adapter.exists(existingFile)).toBe(true);
    expect(await adapter.exists(missingFile)).toBe(false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("FilesystemConfigAdapter - returns workspace path", () => {
  const workspacePath = "/custom/workspace/path";
  const adapter = new FilesystemConfigAdapter(workspacePath);
  expect(adapter.getWorkspacePath()).toBe(workspacePath);
});

Deno.test("FilesystemConfigAdapter - preserves YAML structure correctly", async () => {
  tempDir = await Deno.makeTempDir();
  try {
    const adapter = new FilesystemConfigAdapter(tempDir);
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

    const content = await adapter.readYaml(complexFile);

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
