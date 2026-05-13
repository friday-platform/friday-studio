import type { RequestHandler } from "@sveltejs/kit";
import { api } from "$lib/server/router.ts";

const handler: RequestHandler = ({ request }) => api.fetch(request);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
