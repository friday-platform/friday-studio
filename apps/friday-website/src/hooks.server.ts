import process from "node:process";
import type { Handle, HandleServerError } from "@sveltejs/kit";

function log(level: "info" | "error", message: string, context: Record<string, unknown>) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    service: "friday-website",
    context,
  });
  process.stdout.write(entry + "\n");
}

export const handle: Handle = async ({ event, resolve }) => {
  const start = performance.now();
  const response = await resolve(event);
  const duration = Math.round(performance.now() - start);

  let ip: string | undefined;
  try {
    ip = event.getClientAddress();
  } catch {
    // adapter-node throws if address header is missing (e.g. health checks)
  }

  log(response.status >= 500 ? "error" : "info", "request", {
    method: event.request.method,
    path: event.url.pathname,
    status: response.status,
    duration,
    userAgent: event.request.headers.get("user-agent"),
    ip,
    ...(event.locals.error ? { error: event.locals.error, stack: event.locals.stack } : {}),
  });

  return response;
};

export const handleError: HandleServerError = ({ error, event, message }) => {
  // Stash error details on locals so the handle hook can include them in its
  // single structured log entry. handleError fires inside resolve(), before
  // handle's post-resolve logging runs. This avoids duplicate log lines.
  event.locals.error = error instanceof Error ? error.message : String(error);
  event.locals.stack = error instanceof Error ? error.stack : undefined;

  return { message };
};
