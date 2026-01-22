import * as Sentry from "@sentry/sveltekit";
import { initErrorTracking } from "@atlas/ga4";

Sentry.init({
  dsn: "https://e5d327a9d1eba41a4a4d150c96ab5f9a@o4507579070611456.ingest.us.sentry.io/4510468428726272",
  environment: __SENTRY_ENVIRONMENT__,
  release: __SENTRY_RELEASE__,
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
});

// Analytics - only load in production builds
if (!__DEV_MODE__) {
  // Google Analytics - same property as web-client (Friday)
  const GA_MEASUREMENT_ID = "G-NLLF9SE37C";
  const gaScript = document.createElement("script");
  gaScript.async = true;
  gaScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(gaScript);

  window.dataLayer = window.dataLayer || [];
  window.gtag = (...args: unknown[]) => {
    window.dataLayer.push(args);
  };

  // Set consent defaults - required for GA4 Consent Mode v2
  window.gtag("consent", "default", {
    analytics_storage: "granted",
    ad_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
  });

  window.gtag("js", new Date());
  window.gtag("config", GA_MEASUREMENT_ID);

  // Initialize GA4 error tracking for uncaught errors and promise rejections
  initErrorTracking();
}

// GA4 error tracking is handled by initErrorTracking() global handlers
export const handleError = Sentry.handleErrorWithSentry();
