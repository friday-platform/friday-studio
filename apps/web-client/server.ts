/**
 * Static file server for Atlas Web Client
 * Serves the built SvelteKit static assets
 */

import { serveDir } from "jsr:@std/http/file-server";
import { logger } from "@atlas/logger";

const port = parseInt(Deno.env.get("WEB_CLIENT_PORT") || "3000", 10);
const hostname = Deno.env.get("WEB_CLIENT_HOST") || "0.0.0.0";
const fsRoot = Deno.env.get("WEB_CLIENT_ROOT") || "/home/atlas/web";

const log = logger.child({ component: "web-client" });

log.info("Atlas Web Client starting", { hostname, port, fsRoot });

Deno.serve(
  {
    port,
    hostname,
    onListen: ({ port, hostname }) => {
      log.info("Server listening", { hostname, port });
    },
  },
  async (req) => {
    const start = performance.now();
    const url = new URL(req.url);
    const method = req.method;

    const response = await serveDir(req, { fsRoot, quiet: true });

    const duration = performance.now() - start;
    const status = response.status;

    if (status >= 400) {
      log.warn("Request failed", {
        method,
        path: url.pathname,
        status,
        duration: `${duration.toFixed(2)}ms`,
      });
    } else {
      log.info("Request completed", {
        method,
        path: url.pathname,
        status,
        duration: `${duration.toFixed(2)}ms`,
      });
    }

    return response;
  },
);
