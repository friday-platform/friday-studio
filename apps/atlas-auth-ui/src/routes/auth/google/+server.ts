import { type RequestEvent, redirect } from "@sveltejs/kit";

export function GET({ url }: RequestEvent): Response {
  const authUrl = new URL("/oauth/google/authorize", url.origin);
  const isSignup = url.searchParams.get("signup") === "true";

  if (isSignup) {
    authUrl.searchParams.set("signup", "1");
    authUrl.searchParams.set("redirect_to", "/complete-setup");
  } else {
    authUrl.searchParams.set("redirect_to", "/");
  }

  return redirect(302, authUrl);
}
