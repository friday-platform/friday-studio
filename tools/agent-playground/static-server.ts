/**
 * Production entry point for the bundled `playground` binary.
 *
 * Serves the SvelteKit static build (`build/`) on a fixed port and forwards
 * `/api/*` to the existing Hono router. The build output is embedded into
 * the binary via `deno compile --include build`, so the executable is
 * fully self-contained.
 */
import process from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { api } from "./src/lib/server/router.ts";

const PORT = Number(process.env.PLAYGROUND_PORT ?? "5200");
const HOST = process.env.PLAYGROUND_HOST ?? "127.0.0.1";

// Resolve `./build` relative to this source file, so the path is correct
// both when running via `deno run` from any cwd and when running as a
// `deno compile`'d binary (which embeds the build dir at this same path).
const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_ROOT = join(HERE, "build");
const INDEX_HTML = join(BUILD_ROOT, "index.html");

const app = new Hono()
  .route("/", api)
  .use(
    "/*",
    serveStatic({
      root: BUILD_ROOT,
      rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
    }),
  )
  // SPA fallback: any GET that doesn't resolve to a file or `/api/*` route
  // gets the SvelteKit shell so client-side routing can take over.
  .get("/*", async (c) => {
    const html = await Deno.readTextFile(INDEX_HTML);
    return c.html(html);
  });

console.log(`[playground] listening on http://${HOST}:${PORT}`);
Deno.serve({ port: PORT, hostname: HOST }, app.fetch);
