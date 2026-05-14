import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { Logger } from "@atlas/logger";
import { chatUploadsRoot } from "@atlas/utils/paths.server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReadAttachmentTool } from "./file-io.ts";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function getExecute(
  tool: unknown,
): (input: { path: string; max_bytes?: number }) => Promise<unknown> {
  if (
    typeof tool === "object" &&
    tool !== null &&
    "execute" in tool &&
    typeof (tool as { execute: unknown }).execute === "function"
  ) {
    return (tool as { execute: (input: { path: string; max_bytes?: number }) => Promise<unknown> })
      .execute;
  }
  throw new Error("read_attachment tool has no execute method");
}

const originalHome = process.env.FRIDAY_HOME;
let tempHome: string;

beforeAll(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "read-attachment-test-"));
  process.env.FRIDAY_HOME = tempHome;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe("read_attachment", () => {
  it("allows the current workspace+chat path", async () => {
    const workspaceId = "ws-read-ok";
    const chatId = "chat-read";
    const root = chatUploadsRoot(workspaceId, chatId);
    await mkdir(root, { recursive: true });
    const path = join(root, "notes.txt");
    await writeFile(path, "hello from attachment", "utf8");

    const read = getExecute(createReadAttachmentTool(workspaceId, chatId, logger).read_attachment);
    const result = await read({ path });

    expect(result).toMatchObject({
      path,
      content: "hello from attachment",
      size_bytes: "hello from attachment".length,
      truncated: false,
    });
  });

  it("rejects the same chat id under a different workspace root", async () => {
    const chatId = "chat-collides";
    const foreignRoot = chatUploadsRoot("ws-foreign", chatId);
    await mkdir(foreignRoot, { recursive: true });
    const foreignPath = join(foreignRoot, "secret.txt");
    await writeFile(foreignPath, "do not read", "utf8");

    const read = getExecute(createReadAttachmentTool("ws-current", chatId, logger).read_attachment);
    const result = await read({ path: foreignPath });

    expect(result).toEqual({ error: `path escapes uploads root: ${foreignPath}` });
  });
});
