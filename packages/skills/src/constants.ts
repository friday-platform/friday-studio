/**
 * `createdBy` value reserved for system-bundled skills (auto-loaded from
 * `packages/system/skills/<name>/` at daemon start). Lives in this leaf
 * module so consumers can import it without pulling the JetStream adapter
 * cone via the `mod.ts` barrel.
 */
export const SYSTEM_USER_ID = "system";
