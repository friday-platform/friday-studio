import * as Sentry from "@sentry/sveltekit";

Sentry.init({
  dsn: "https://77dace58355275e47253baf5a5b1c5d6@o4507579070611456.ingest.us.sentry.io/4510468388159488",
  environment: __SENTRY_ENVIRONMENT__,
  release: __SENTRY_RELEASE__,
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
});

export const handleError = Sentry.handleErrorWithSentry();
