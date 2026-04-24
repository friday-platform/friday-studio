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
    results: Record<string, Record<string, unknown>>;
  };
  signal: { type: string; data?: Record<string, unknown> };
  timeout: number;
}

interface Mutation {
  op: "updateDoc" | "createDoc" | "deleteDoc" | "emit" | "setResult" | "stateAppend";
  args: unknown[];
}

interface StateCache {
  [key: string]: Array<{ data: string; _ts: string }>;
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

  const { requestId, functionCode, contextData, signal } = request;

  try {
    // MUST await - user code can be async.
    // Timeout is enforced by the parent WorkerExecutor, which terminates this
    // worker via discardAndReplenish() — we don't self-timeout here so that
    // async infinite loops don't sneak a still-running worker back into the pool.
    const { result, mutations } = await executeFunction(functionCode, contextData, signal);
    postMessage(JSON.stringify({ requestId, success: true, result, mutations }));
  } catch (error) {
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
    results: contextData.results ?? {},

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

    setResult(key: string, data: Record<string, unknown>) {
      // Update local results so subsequent reads in the same execution see the write
      context.results[key] = data;
      mutations.push({ op: "setResult", args: [key, data] });
    },

    // State tools — pre-loaded cache enables local filtering, append is fire-and-forget

    /**
     * Dedup filter: given a list of candidate values, return those NOT already
     * present in the state cache under `field`. Use for idempotent append logic.
     */
    stateFilter(
      key: string,
      field: string,
      values: Array<string | number>,
    ): Array<string | number> {
      const results = contextData.results ?? {};
      const cache: StateCache = (results.__stateCache ?? {}) as StateCache;
      const entries = cache[key] ?? [];
      const existing = new Set<string>();
      for (const entry of entries) {
        try {
          const raw: unknown = JSON.parse(entry.data);
          if (typeof raw === "object" && raw !== null && field in raw) {
            existing.add(String((raw as Record<string, unknown>)[field]));
          }
        } catch {
          // Skip corrupt entries
        }
      }
      return values.filter((v) => !existing.has(String(v)));
    },

    /**
     * Query filter: return all entries in `key` whose fields match every
     * key-value pair in `filter`. Use for reading state by ID or tag.
     */
    stateQuery(key: string, filter: Record<string, unknown>): Record<string, unknown>[] {
      const results = contextData.results ?? {};
      const cache: StateCache = (results.__stateCache ?? {}) as StateCache;
      const entries = cache[key] ?? [];
      const matched: Record<string, unknown>[] = [];
      for (const entry of entries) {
        try {
          const raw: unknown = JSON.parse(entry.data);
          if (typeof raw !== "object" || raw === null) continue;
          const obj = raw as Record<string, unknown>;
          const matches = Object.keys(filter).every((k) => obj[k] === filter[k]);
          if (matches) matched.push(obj);
        } catch {
          // Skip corrupt entries
        }
      }
      return matched;
    },

    stateAppend(key: string, entry: Record<string, unknown>, ttlHours?: number) {
      mutations.push({ op: "stateAppend", args: [key, entry, ttlHours] });
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
