import { redirect, type LoadEvent } from "@sveltejs/kit";

export const prerender = false;

export function load({ url }: LoadEvent): void {
  const authUrl = new URL("/oauth/google/authorize", url.origin);
  const isSignup = url.searchParams.get("signup") === "true";

  if (isSignup) {
    authUrl.searchParams.set("signup", "1");
    authUrl.searchParams.set("redirect_to", "/complete-setup");
  } else {
    authUrl.searchParams.set("redirect_to", "/");
  }

  redirect(302, authUrl.toString());
}
