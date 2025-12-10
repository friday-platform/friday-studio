import process from "node:process";

/**
 * Determines if insecure HTTP requests should be allowed.
 * oauth4webapi requires HTTPS by default and we need to override that in
 * local development and for tests.
 */
export function shouldAllowInsecureForLocalDev(): boolean {
  return process.env.LINK_ALLOW_INSECURE_HTTP === "true";
}
