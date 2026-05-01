import { InMemoryDocumentStore } from "../../../document-store/node.ts";
import { FSMDocumentDataSchema } from "../../document-schemas.ts";
import { FSMEngine } from "../../fsm-engine.ts";
import type { FSMDefinition } from "../../types.ts";

export interface TestContext {
  engine: FSMEngine;
  store: InMemoryDocumentStore;
  scope: { workspaceId: string; sessionId: string };
}

export async function createTestEngine(
  fsm: FSMDefinition,
  options: {
    initialState?: string;
    documents?: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  } = {},
): Promise<TestContext> {
  const store = new InMemoryDocumentStore();
  const scope = { workspaceId: "test", sessionId: "test-session" };

  if (options.initialState) {
    const stateResult = await store.saveState(scope, fsm.id, { state: options.initialState });
    if (!stateResult.ok) throw new Error(`Test setup: ${stateResult.error}`);
  }

  if (options.documents) {
    for (const doc of options.documents) {
      const writeResult = await store.write(
        scope,
        fsm.id,
        doc.id,
        { type: doc.type, data: doc.data },
        FSMDocumentDataSchema,
      );
      if (!writeResult.ok) throw new Error(`Test setup: ${writeResult.error}`);
    }
  }

  const engine = new FSMEngine(fsm, { documentStore: store, scope });
  await engine.initialize();

  return { engine, store, scope };
}
