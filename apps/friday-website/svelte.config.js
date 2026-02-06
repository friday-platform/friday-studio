import process from "node:process";
import adapter from "@sveltejs/adapter-node";

const dev = process.argv.includes("dev");

const REPORT_ENDPOINT = "https://dm35suqd.uriports.com/reports";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ port: 3000 }),
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self", "report-sample"],
        "style-src": ["self", "unsafe-inline", "report-sample"],
        "img-src": ["self", "data:"],
        "frame-src": ["self", "https://www.youtube.com"],
        "font-src": ["self"],
        "connect-src": ["self"],
        "object-src": ["none"],
        "frame-ancestors": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
        "report-uri": [`${REPORT_ENDPOINT}/report`],
        "report-to": ["default"],
        ...(dev ? {} : { "upgrade-insecure-requests": true }),
      },
    },
  },
};

export default config;
