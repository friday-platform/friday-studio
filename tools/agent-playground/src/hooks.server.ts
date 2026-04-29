import { building } from "$app/environment";
import type { Handle } from "@sveltejs/kit";
import process from "node:process";
import { parse } from "node-html-parser";

const config: Record<string, string> = {};
if (process.env.EXTERNAL_DAEMON_URL) config.externalDaemonUrl = process.env.EXTERNAL_DAEMON_URL;
if (process.env.EXTERNAL_TUNNEL_URL) config.externalTunnelUrl = process.env.EXTERNAL_TUNNEL_URL;

// `!building`: prerendered HTML is what static-server.ts re-injects
// against in production; injecting at build time would bake the wrong
// (build-host) env into the artifact.
const shouldInject = !building && Object.keys(config).length > 0;
const configJson = JSON.stringify(config).replace(/</g, "\\u003c");
const configScript = `<script>window.__FRIDAY_CONFIG__=${configJson};</script>`;

function injectConfig(html: string): string {
	const root = parse(html);
	const head = root.querySelector("head");
	if (!head) return html;
	head.appendChild(parse(configScript));
	return root.toString();
}

export const handle: Handle = ({ event, resolve }) =>
	resolve(event, {
		transformPageChunk: ({ html, done }) => {
			if (!shouldInject || !done) return html;
			return injectConfig(html);
		},
	});
