import { effectiveDaemonUrl } from "$lib/server/daemon-url";
import { buildProxyHandler } from "$lib/server/proxy";

const handler = buildProxyHandler({ upstream: effectiveDaemonUrl(), label: "daemon" });

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
