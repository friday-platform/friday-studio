import * as Sentry from "@sentry/sveltekit";

Sentry.init({
  dsn: "https://e5d327a9d1eba41a4a4d150c96ab5f9a@o4507579070611456.ingest.us.sentry.io/4510468428726272",
  environment: import.meta.env.DEV ? "local" : process.env.SENTRY_ENVIRONMENT || "production",
  release: __SENTRY_RELEASE__,
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
});

export const handleError = Sentry.handleErrorWithSentry();
