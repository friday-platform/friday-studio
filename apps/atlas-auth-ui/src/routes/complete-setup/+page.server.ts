import { env } from "$env/dynamic/public";

export function load() {
  return { appUrl: env.PUBLIC_APP_URL || "http://localhost:5173" };
}
