import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import process from "node:process";

const execFileAsync = promisify(execFile);

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".html": "text/html",
  ".htm": "text/html",
};

export const shellRoute = new Hono()
  /**
   * POST /api/shell/open-path — opens a local file with its default app.
   * Playground-only dev tool.
   */
  .post(
    "/open-path",
    zValidator("json", z.object({ path: z.string() })),
    async (c) => {
      const { path } = c.req.valid("json");
      if (!isAbsolute(path)) {
        return c.json({ error: "Path must be absolute" }, 400);
      }
      try {
        if (process.platform === "darwin") {
          await execFileAsync("open", [path]);
        } else if (process.platform === "linux") {
          await execFileAsync("xdg-open", [path]);
        } else {
          return c.json({ error: "Unsupported platform" }, 400);
        }
        return c.json({ ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 500);
      }
    },
  )
  /**
   * GET /api/shell/serve-file?path=... — serves a local file as raw bytes.
   * Used for inline image and HTML rendering in artifact cards.
   */
  .get(
    "/serve-file",
    zValidator("query", z.object({ path: z.string() })),
    async (c) => {
      const { path } = c.req.valid("query");
      if (!isAbsolute(path)) {
        return c.json({ error: "Path must be absolute" }, 400);
      }
      try {
        const data = await readFile(path);
        const contentType = EXT_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
        return new Response(data, { headers: { "content-type": contentType } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: msg }, 404);
      }
    },
  );
