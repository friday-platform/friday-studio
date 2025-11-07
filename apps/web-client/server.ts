/**
 * Static file server for Atlas Web Client (Production)
 * Serves static assets only - API routing handled at ingress level
 */

import { logger } from "@atlas/logger";
import { serveDir } from "@std/http/file-server";

const port = parseInt(Deno.env.get("WEB_CLIENT_PORT") || "3000", 10);
const hostname = Deno.env.get("WEB_CLIENT_HOST") || "0.0.0.0";
const fsRoot = Deno.env.get("WEB_CLIENT_ROOT") || "/home/atlas/web";

const log = logger.child({ component: "web-client" });

log.info("Atlas Web Client starting", { hostname, port, fsRoot });

Deno.serve(
  {
    port,
    hostname,
    onListen: ({ port, hostname }) => log.info("Server listening", { hostname, port }),
  },
  async (req) => {
    const start = performance.now();
    const url = new URL(req.url);

    const response = await serveDir(req, { fsRoot, quiet: true });

    const duration = performance.now() - start;
    const logLevel = response.status >= 400 ? "warn" : "info";
    log[logLevel]("Request completed", {
      method: req.method,
      path: url.pathname,
      status: response.status,
      duration: `${duration.toFixed(2)}ms`,
    });

    return response;
  },
);
