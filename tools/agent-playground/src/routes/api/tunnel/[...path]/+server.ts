import { effectiveTunnelUrl } from "$lib/server/daemon-url";
import { buildProxyHandler } from "$lib/server/proxy";

const handler = buildProxyHandler({ upstream: effectiveTunnelUrl(), label: "tunnel" });

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
