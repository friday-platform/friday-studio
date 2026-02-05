import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
const config = { kit: { adapter: adapter({ port: 3000 }) } };

export default config;
