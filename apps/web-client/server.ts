/**
 * Static file server for Atlas Web Client
 * Serves the built SvelteKit static assets
 */

import { serveDir } from "jsr:@std/http/file-server";

const port = parseInt(Deno.env.get("WEB_CLIENT_PORT") || "3000");
const hostname = Deno.env.get("WEB_CLIENT_HOST") || "0.0.0.0";
const fsRoot = Deno.env.get("WEB_CLIENT_ROOT") || "/home/atlas/web";

console.log(`Atlas Web Client starting on http://${hostname}:${port}`);
console.log(`Serving files from: ${fsRoot}`);

Deno.serve(
  {
    port,
    hostname,
    onListen: ({ port, hostname }) => {
      console.log(`Server running at http://${hostname}:${port}/`);
    },
  },
  (req) => {
    return serveDir(req, { fsRoot, quiet: false });
  },
);
