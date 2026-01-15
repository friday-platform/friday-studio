/**
 * Sandboxed Worker for FSM Function Execution
 *
 * CRITICAL: NO IMPORTS - worker runs with zero permissions.
 * All utilities must be defined inline.
 */

interface WorkerRequest {
  requestId: string;
  functionCode: string;
  contextData: {
    documents: Array<{ id: string; type: string; data: Record<string, unknown> }>;
    state: string;
  };
  signal: { type: string; data?: Record<string, unknown> };
  timeout: number;
}

interface Mutation {
  op: "updateDoc" | "createDoc" | "deleteDoc" | "emit";
  args: unknown[];
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// biome-ignore lint/suspicious/noGlobalAssign: Web Worker pattern
onmessage = async (e: MessageEvent<string>) => {
  let request: WorkerRequest;
  try {
    request = JSON.parse(e.data) as WorkerRequest;
  } catch {
    return;
  }

  const { requestId, functionCode, contextData, signal, timeout } = request;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
    postMessage(JSON.stringify({ requestId, success: false, error: `Timeout after ${timeout}ms` }));
    close(); // Self-terminate worker
  }, timeout);

  try {
    // MUST await - user code can be async
    const { result, mutations } = await executeFunction(functionCode, contextData, signal);
    clearTimeout(timeoutId);

    if (controller.signal.aborted) return;

    postMessage(JSON.stringify({ requestId, success: true, result, mutations }));
  } catch (error) {
    clearTimeout(timeoutId);

    if (controller.signal.aborted) return;

    const stack = error instanceof Error ? error.stack : undefined;
    postMessage(JSON.stringify({ requestId, success: false, error: stringifyError(error), stack }));
  }
};

async function executeFunction(
  code: string,
  contextData: WorkerRequest["contextData"],
  signal: WorkerRequest["signal"],
): Promise<{ result: unknown; mutations: Mutation[] }> {
  const mutations: Mutation[] = [];

  // Mutable local copy of documents
  const documents = contextData.documents.map((d) => ({
    id: d.id,
    type: d.type,
    data: { ...d.data },
  }));

  const context = {
    documents,
    state: contextData.state,

    // SYNC methods - mutate local + record mutation
    updateDoc(id: string, data: Record<string, unknown>) {
      const doc = documents.find((d) => d.id === id);
      if (!doc) {
        throw new Error(`Cannot update document "${id}" - does not exist`);
      }
      doc.data = { ...doc.data, ...data };
      mutations.push({ op: "updateDoc", args: [id, data] });
    },

    createDoc(doc: { id: string; type: string; data: Record<string, unknown> }) {
      if (documents.find((d) => d.id === doc.id)) {
        throw new Error(`Cannot create document "${doc.id}" - already exists`);
      }
      documents.push({ ...doc, data: { ...doc.data } });
      mutations.push({ op: "createDoc", args: [doc] });
    },

    deleteDoc(id: string) {
      const idx = documents.findIndex((d) => d.id === id);
      if (idx >= 0) documents.splice(idx, 1);
      mutations.push({ op: "deleteDoc", args: [id] });
    },

    emit(sig: { type: string; data?: Record<string, unknown> }) {
      mutations.push({ op: "emit", args: [sig] });
    },
  };

  // Transform code
  let cleanCode = code.trim();
  if (cleanCode.startsWith("export default")) {
    cleanCode = cleanCode.replace("export default", "const __fn__ =");
  } else {
    cleanCode = `const __fn__ = ${cleanCode}`;
  }

  const fn = new Function("context", "event", `${cleanCode}; return __fn__(context, event);`);

  // Execute and await if Promise (handles both sync and async user code)
  const rawResult = fn(context, signal);
  const result = await Promise.resolve(rawResult);

  return { result, mutations };
}
