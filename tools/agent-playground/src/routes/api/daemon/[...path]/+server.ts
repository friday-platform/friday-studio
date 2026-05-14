import { DAEMON_BASE_URL } from "$lib/daemon-url";
import { buildProxyHandler } from "$lib/server/proxy";

const handler = buildProxyHandler({ upstream: DAEMON_BASE_URL, label: "daemon" });

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
