import type { Handle } from "@sveltejs/kit";
import { buildFeatureFlags, parseCookieOverrides } from "$lib/feature-flags";

export const handle: Handle = ({ event, resolve }) => {
  const cookieHeader = event.request.headers.get("cookie") ?? "";
  const overrides = parseCookieOverrides(cookieHeader);
  event.locals.featureFlags = buildFeatureFlags(overrides);
  return resolve(event);
};
