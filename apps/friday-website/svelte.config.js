import process from "node:process";
import adapter from "@sveltejs/adapter-node";
import { makeDirectives } from "./src/lib/csp-directives.js";

const dev = process.argv.includes("dev");

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({ port: 3000 }),
    csp: { mode: "auto", directives: makeDirectives({ dev }) },
    version: { name: process.env.GIT_COMMIT_SHA ?? "dev" },
  },
};

export default config;
