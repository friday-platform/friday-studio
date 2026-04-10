import { describe, expect, it } from "vitest";
import { type BashToolInput, type BashToolOutput, createBashTool } from "./bash-tool.ts";

/** Execute the bash tool and return the non-streaming result */
async function exec(
  bashTool: ReturnType<typeof createBashTool>,
  input: BashToolInput,
  id: string,
): Promise<BashToolOutput> {
  const result = await bashTool.execute?.(input, { toolCallId: id, messages: [] });
  if (!result) throw new Error("execute returned undefined");
  // execute always returns a single object for this tool, never an async iterable
  if (!("stdout" in result)) throw new Error("unexpected stream");
  return result;
}

describe("createBashTool", () => {
  const bashTool = createBashTool();

  it("has correct shape: description, inputSchema, execute", () => {
    expect(bashTool.description).toBe(
      "Execute a bash command and return stdout, stderr, and exit code.",
    );
    expect(bashTool.inputSchema).toBeDefined();
    expect(bashTool.execute).toBeTypeOf("function");
  });

  it("inputSchema has required command field", () => {
    const schema = bashTool.inputSchema;
    // jsonSchema() wraps the raw JSON Schema — access via the jsonSchema property
    expect(schema).toHaveProperty("jsonSchema");
    const raw = (schema as Record<string, unknown>).jsonSchema as Record<string, unknown>;
    expect(raw.type).toBe("object");
    expect(raw.required).toEqual(["command"]);
    const props = raw.properties as Record<string, unknown>;
    expect(props).toHaveProperty("command");
    expect(props).toHaveProperty("cwd");
    expect(props).toHaveProperty("env");
    expect(props).toHaveProperty("timeout_ms");
  });

  it("executes a simple echo command", async () => {
    const result = await exec(bashTool, { command: "echo hello" }, "test-1");
    expect(result).toEqual({ stdout: "hello\n", stderr: "", exit_code: 0 });
  });

  it("returns non-zero exit code without throwing", async () => {
    const result = await exec(bashTool, { command: "exit 42" }, "test-2");
    expect(result.exit_code).toBe(42);
  });

  it("captures stderr", async () => {
    const result = await exec(bashTool, { command: "echo oops >&2" }, "test-3");
    expect(result.stderr).toBe("oops\n");
    expect(result.exit_code).toBe(0);
  });

  it("respects custom cwd", async () => {
    const result = await exec(bashTool, { command: "pwd", cwd: "/tmp" }, "test-4");
    // /tmp may resolve to /private/tmp on macOS
    expect(result.stdout.trim()).toMatch(/\/?tmp$/);
    expect(result.exit_code).toBe(0);
  });

  it("merges custom env (agent env takes precedence)", async () => {
    const result = await exec(
      bashTool,
      { command: "echo $BASH_TOOL_TEST_VAR", env: { BASH_TOOL_TEST_VAR: "bar" } },
      "test-5",
    );
    expect(result.stdout.trim()).toBe("bar");
  });

  it("times out on long-running commands", async () => {
    const result = await exec(bashTool, { command: "sleep 60", timeout_ms: 100 }, "test-6");
    expect(result.exit_code).not.toBe(0);
  }, 5000);
});
