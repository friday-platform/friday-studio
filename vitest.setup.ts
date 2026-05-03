/**
 * Global vitest setup.
 *
 * Wires module-singleton storages with in-memory test fakes so suites
 * that exercise the workspace runtime / FSM engine don't have to
 * individually opt in. Production daemons call the real
 * `init*Storage(nc)` against a NATS connection at startup; vitest
 * never has one, so without this hook every workspace-runtime test
 * crashes on the first DocumentStore access.
 *
 * Tests that need a custom adapter call `setDocumentStoreForTest(...)`
 * / `_setSkillStorageForTest(...)` themselves; the call here is the
 * default fallback.
 */

import { InMemoryDocumentStore, setDocumentStoreForTest } from "@atlas/document-store";
// Deep imports to avoid pulling @atlas/skills's barrel, which loads
// archive.ts → tar at module-eval time and would interfere with
// per-file `vi.mock("../src/archive.ts", ...)` hoists.
import { InMemorySkillAdapter } from "@atlas/skills/in-memory-adapter";
import { _setSkillStorageForTest } from "@atlas/skills/storage";

setDocumentStoreForTest(new InMemoryDocumentStore());
_setSkillStorageForTest(new InMemorySkillAdapter());
