import { registry } from "$lib/server/metrics";
import type { RequestHandler } from "./$types";

export const prerender = false;

export const GET: RequestHandler = async () => {
  const metrics = await registry.metrics();
  return new Response(metrics, { headers: { "content-type": registry.contentType } });
};
