import * as Sentry from "@sentry/sveltekit";
import type { Handle } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";

Sentry.init({
  dsn: "https://e5d327a9d1eba41a4a4d150c96ab5f9a@o4507579070611456.ingest.us.sentry.io/4510468428726272",
  environment: import.meta.env.DEV ? "local" : process.env.SENTRY_ENVIRONMENT || "production",
  release: __SENTRY_RELEASE__,
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
});

export const handleError = Sentry.handleErrorWithSentry();

const securityHeaders: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Content-Security-Policy for auth pages
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com",
      "connect-src 'self' https://o4507579070611456.ingest.us.sentry.io https://www.google-analytics.com https://analytics.google.com https://*.google-analytics.com",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://accounts.google.com",
    ].join("; "),
  );

  return response;
};

export const handle = sequence(Sentry.sentryHandle(), securityHeaders);
