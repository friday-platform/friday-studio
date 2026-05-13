import { TUNNEL_BASE_URL } from "$lib/daemon-url";
import { buildProxyHandler } from "$lib/server/proxy";

const handler = buildProxyHandler({ upstream: TUNNEL_BASE_URL, label: "tunnel" });

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
