import * as Sentry from "@sentry/sveltekit";

Sentry.init({
  dsn: "https://77dace58355275e47253baf5a5b1c5d6@o4507579070611456.ingest.us.sentry.io/4510468388159488",
  environment: __SENTRY_ENVIRONMENT__,
  release: __SENTRY_RELEASE__,
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
});

// Analytics - only load in production builds
if (!__DEV_MODE__) {
  // Google Analytics
  const GA_MEASUREMENT_ID = "G-GEJY2HP1CT";
  const gaScript = document.createElement("script");
  gaScript.async = true;
  gaScript.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(gaScript);

  window.dataLayer = window.dataLayer || [];
  function gtag(...args: unknown[]) {
    window.dataLayer.push(args);
  }
  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID);

  // Microsoft Clarity
  const CLARITY_PROJECT_ID = "ug35a2otup";
  if (!window.clarity) {
    const clarityFn = (...args: unknown[]) => {
      clarityFn.q.push(args);
    };
    clarityFn.q = [] as unknown[];
    window.clarity = clarityFn;
  }
  const clarityScript = document.createElement("script");
  clarityScript.async = true;
  clarityScript.src = `https://www.clarity.ms/tag/${CLARITY_PROJECT_ID}`;
  document.head.appendChild(clarityScript);
}

export const handleError = Sentry.handleErrorWithSentry();
