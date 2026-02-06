import process from "node:process";
import adapter from "@sveltejs/adapter-node";

const dev = process.argv.includes("dev");

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ port: 3000 }),
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "frame-src": ["self", "https://www.youtube.com"],
        "font-src": ["self"],
        "connect-src": ["self"],
        "object-src": ["none"],
        "frame-ancestors": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
        ...(dev ? {} : { "upgrade-insecure-requests": true }),
      },
    },
  },
};

export default config;
