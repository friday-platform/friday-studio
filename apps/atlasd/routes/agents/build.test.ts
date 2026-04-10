import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/** Response shape for error responses */
const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  phase: z.string().optional(),
});

/** Response shape for successful build responses */
const SuccessResponseSchema = z.object({
  ok: z.literal(true),
  agent: z.object({
    id: z.string(),
    version: z.string(),
    description: z.string(),
    path: z.string(),
  }),
});

const mockBuildAgent = vi.fn();

vi.mock("@atlas/workspace/agent-builder", () => ({
  buildAgent: mockBuildAgent,
  AgentBuildError: class AgentBuildError extends Error {
    phase: string;
    constructor(message: string, phase: string) {
      super(message);
      this.name = "AgentBuildError";
      this.phase = phase;
    }
  },
}));

vi.mock("@atlas/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

// Import after mocks are set up
const { buildAgentRoute } = await import("./build.ts");
const { AgentBuildError } = await import("@atlas/workspace/agent-builder");

// Wrap buildAgentRoute with mock app context so c.get("app") works
const { daemonFactory } = await import("../../src/factory.ts");
const app = daemonFactory.createApp();
app.use("*", async (c, next) => {
  c.set("app", { getAgentRegistry: () => ({ reload: vi.fn() }) } as never);
  await next();
});
app.route("/", buildAgentRoute);

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /build", () => {
  it("rejects non-multipart requests", async () => {
    const response = await app.request("/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.ok).toBe(false);
    expect(body.error).toContain("multipart/form-data");
  });

  it("rejects requests with no files", async () => {
    const formData = new FormData();
    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.ok).toBe(false);
    expect(body.error).toContain("At least one Python source file");
  });

  it("rejects non-.py files", async () => {
    const formData = new FormData();
    formData.append("files", new File(["print('hi')"], "agent.txt", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Only .py files");
  });

  it("returns built agent on success", async () => {
    mockBuildAgent.mockResolvedValue({
      id: "test-agent",
      version: "1.0.0",
      description: "A test agent",
      outputPath: "/data/atlas/agents/test-agent@1.0.0",
    });

    const formData = new FormData();
    formData.append("files", new File(["print('hello')"], "agent.py", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(200);
    const body = SuccessResponseSchema.parse(await response.json());
    expect(body).toEqual({
      ok: true,
      agent: {
        id: "test-agent",
        version: "1.0.0",
        description: "A test agent",
        path: "/data/atlas/agents/test-agent@1.0.0",
      },
    });

    // Verify buildAgent was called with the right structure
    expect(mockBuildAgent).toHaveBeenCalledOnce();
    const callArgs = mockBuildAgent.mock.calls[0]?.[0];
    expect(callArgs.entryPoint).toBe("agent");
    expect(callArgs.sdkPath).toBe("/opt/friday-agent-sdk");
  });

  it("uses custom entry_point from form data", async () => {
    mockBuildAgent.mockResolvedValue({
      id: "custom",
      version: "1.0.0",
      description: "Custom",
      outputPath: "/data/atlas/agents/custom@1.0.0",
    });

    const formData = new FormData();
    formData.append("files", new File(["print('hello')"], "my_agent.py", { type: "text/plain" }));
    formData.append("entry_point", "my_agent");

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(200);
    const callArgs = mockBuildAgent.mock.calls[0]?.[0];
    expect(callArgs.entryPoint).toBe("my_agent");
  });

  it("derives entry_point from first file name when not specified", async () => {
    mockBuildAgent.mockResolvedValue({
      id: "app",
      version: "1.0.0",
      description: "App",
      outputPath: "/data/atlas/agents/app@1.0.0",
    });

    const formData = new FormData();
    formData.append("files", new File(["print('hello')"], "app.py", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(200);
    const callArgs = mockBuildAgent.mock.calls[0]?.[0];
    expect(callArgs.entryPoint).toBe("app");
  });

  it("returns 400 for compile errors", async () => {
    mockBuildAgent.mockRejectedValue(new AgentBuildError("SyntaxError: invalid syntax", "compile"));

    const formData = new FormData();
    formData.append("files", new File(["def bad("], "agent.py", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.ok).toBe(false);
    expect(body.phase).toBe("compile");
    expect(body.error).toContain("SyntaxError");
  });

  it("returns 400 for validation errors", async () => {
    mockBuildAgent.mockRejectedValue(
      new AgentBuildError(
        "Agent metadata validation failed:\n  - description: Required",
        "validate",
      ),
    );

    const formData = new FormData();
    formData.append("files", new File(["print('hi')"], "agent.py", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(400);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.ok).toBe(false);
    expect(body.phase).toBe("validate");
    expect(body.error).toContain("description");
  });

  it("returns 500 for transpile errors", async () => {
    mockBuildAgent.mockRejectedValue(new AgentBuildError("jco transpile failed", "transpile"));

    const formData = new FormData();
    formData.append("files", new File(["print('hi')"], "agent.py", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(500);
    const body = ErrorResponseSchema.parse(await response.json());
    expect(body.ok).toBe(false);
    expect(body.phase).toBe("transpile");
  });

  it("accepts files[] field name (bracket syntax)", async () => {
    mockBuildAgent.mockResolvedValue({
      id: "test",
      version: "1.0.0",
      description: "Test",
      outputPath: "/data/atlas/agents/test@1.0.0",
    });

    const formData = new FormData();
    formData.append("files[]", new File(["print('hello')"], "agent.py", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(200);
    expect(mockBuildAgent).toHaveBeenCalledOnce();
  });

  it("accepts multiple files", async () => {
    mockBuildAgent.mockResolvedValue({
      id: "multi",
      version: "1.0.0",
      description: "Multi",
      outputPath: "/data/atlas/agents/multi@1.0.0",
    });

    const formData = new FormData();
    formData.append(
      "files",
      new File(["from helper import util"], "agent.py", { type: "text/plain" }),
    );
    formData.append("files", new File(["def util(): pass"], "helper.py", { type: "text/plain" }));

    const response = await app.request("/build", { method: "POST", body: formData });

    expect(response.status).toBe(200);
    expect(mockBuildAgent).toHaveBeenCalledOnce();
  });
});
