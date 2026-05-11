import type { Handle } from "@sveltejs/kit";

export const handle: Handle = ({ event, resolve }) => resolve(event);
