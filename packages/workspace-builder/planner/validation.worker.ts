/**
 * Sandboxed Worker for Transform Expression Validation
 *
 * CRITICAL: NO IMPORTS - worker runs with zero permissions.
 * Receives an expression + mock data, executes via new Function(), returns result.
 */

// biome-ignore lint/suspicious/noGlobalAssign: Web Worker pattern
onmessage = (e: MessageEvent<string>) => {
  let request: {
    requestId: string;
    expression: string;
    mockValue: unknown;
    mockDocs: Record<string, unknown>;
    timeout: number;
  };
  try {
    request = JSON.parse(e.data) as typeof request;
  } catch {
    return;
  }

  const { requestId, expression, mockValue, mockDocs, timeout } = request;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    postMessage(JSON.stringify({ requestId, success: false, error: `Timeout after ${timeout}ms` }));
  }, timeout);

  try {
    const fn = new Function("value", "docs", `return ${expression}`);
    const result = fn(mockValue, mockDocs);
    clearTimeout(timeoutId);
    if (controller.signal.aborted) return;
    postMessage(JSON.stringify({ requestId, success: true, result }));
  } catch (error) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) return;
    postMessage(JSON.stringify({ requestId, success: false, error: String(error) }));
  }
};
