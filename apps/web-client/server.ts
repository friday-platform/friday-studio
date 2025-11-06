/**
 * Static file server for Atlas Web Client (Production)
 * Serves static assets and proxies API/streams requests to daemon
 */

import { logger } from "@atlas/logger";
import { serveDir } from "@std/http/file-server";
import { proxyToDaemon, shouldProxyToDaemon } from "./src/lib/server/proxy-util.ts";

const port = parseInt(Deno.env.get("WEB_CLIENT_PORT") || "3000", 10);
const hostname = Deno.env.get("WEB_CLIENT_HOST") || "0.0.0.0";
const fsRoot = Deno.env.get("WEB_CLIENT_ROOT") || "/home/atlas/web";
const daemonUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://127.0.0.1:8080";

const log = logger.child({ component: "web-client" });

log.info("Atlas Web Client starting", { hostname, port, fsRoot, daemonUrl });

Deno.serve(
  {
    port,
    hostname,
    onListen: ({ port, hostname }) => log.info("Server listening", { hostname, port }),
  },
  async (req) => {
    const start = performance.now();
    const url = new URL(req.url);

    let response: Response;

    if (shouldProxyToDaemon(url.pathname)) {
      const pathParts = url.pathname.split("/").filter(Boolean);
      const prefix = `/${pathParts[0]}`;
      const path = pathParts.slice(1).join("/");
      response = await proxyToDaemon(prefix, path, url, req, daemonUrl);
    } else {
      response = await serveDir(req, { fsRoot, quiet: true });
    }

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
