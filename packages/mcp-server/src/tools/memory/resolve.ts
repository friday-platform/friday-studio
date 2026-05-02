/**
 * Resolve a memory tool call against the workspace's memory config.
 *
 * Enforces the `memory.own` / `memory.mounts` declarations on workspace.yml:
 *   - Writing to a memory not declared as `own` or not reachable via an `rw`
 *     mount is rejected.
 *   - Reads accept any declared memory (own or mount, any mode).
 *   - Mount aliases translate to the source (workspaceId, memoryName).
 */

import { parseMemoryMountSource } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";

/** Operation class — `read` allows any declared memory, `write` requires own or rw mount. */
export type MemoryOp = "read" | "write";

export type MemoryStrategy = "narrative";

export interface ResolvedStore {
  /** Workspace that actually holds the entries (equals input workspaceId unless the call was via a mount). */
  effectiveWorkspaceId: string;
  /** Memory name on disk (may differ from the mount alias the agent passed). */
  effectiveMemoryName: string;
  /** Storage strategy — always "narrative" after the 2026-05 cleanup. */
  strategy: MemoryStrategy;
}

const MemoryOwnRow = z.object({
  name: z.string(),
  type: z.enum(["short_term", "long_term", "scratchpad"]),
  strategy: z.literal("narrative").optional(),
});

const MemoryMountRow = z.object({
  name: z.string(),
  source: z.string(),
  mode: z.enum(["ro", "rw"]).default("ro"),
});

const MemoryBlock = z
  .object({
    own: z.array(MemoryOwnRow).optional().default([]),
    mounts: z.array(MemoryMountRow).optional().default([]),
  })
  .optional();

const ConfigEnvelope = z.object({ config: z.object({ memory: MemoryBlock }).passthrough() });

/**
 * Resolve a store against the workspace config without strategy enforcement.
 * Returns `strategy` so callers can dispatch to the right backend.
 */
export async function resolveStore(args: {
  daemonUrl: string;
  workspaceId: string;
  memoryName: string;
  op: MemoryOp;
  logger: Logger;
}): Promise<{ ok: true; resolved: ResolvedStore } | { ok: false; error: string }> {
  const { daemonUrl, workspaceId, memoryName, op, logger } = args;

  let cfg: z.infer<typeof MemoryBlock>;
  try {
    const url = `${daemonUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/config`;
    const res = await fetch(url);
    if (!res.ok) {
      return { ok: false, error: `workspace '${workspaceId}' not found (HTTP ${res.status})` };
    }
    const parsed = ConfigEnvelope.safeParse(await res.json());
    if (!parsed.success) {
      return { ok: false, error: `malformed config response: ${parsed.error.message}` };
    }
    cfg = parsed.data.config.memory;
  } catch (err) {
    logger.warn("resolveStore: config fetch failed", {
      workspaceId,
      memoryName,
      error: stringifyError(err),
    });
    return { ok: false, error: `failed to load workspace config: ${stringifyError(err)}` };
  }

  const own = cfg?.own ?? [];
  const mounts = cfg?.mounts ?? [];

  // 1. Check memory.own first — simple case.
  const ownMatch = own.find((e) => e.name === memoryName);
  if (ownMatch) {
    return {
      ok: true,
      resolved: {
        effectiveWorkspaceId: workspaceId,
        effectiveMemoryName: memoryName,
        strategy: ownMatch.strategy ?? "narrative",
      },
    };
  }

  // 2. Check mounts — the mount's `name` is the agent-facing alias.
  const mountMatch = mounts.find((m) => m.name === memoryName);
  if (mountMatch) {
    if (op === "write" && mountMatch.mode !== "rw") {
      return {
        ok: false,
        error: `mount '${memoryName}' is mode '${mountMatch.mode}', not writable. Only 'rw' mounts accept writes.`,
      };
    }
    let parsedSource: ReturnType<typeof parseMemoryMountSource>;
    try {
      parsedSource = parseMemoryMountSource(mountMatch.source);
    } catch (err) {
      return {
        ok: false,
        error: `mount '${memoryName}' has malformed source '${mountMatch.source}': ${stringifyError(err)}`,
      };
    }
    return {
      ok: true,
      resolved: {
        effectiveWorkspaceId: parsedSource.workspaceId,
        effectiveMemoryName: parsedSource.memoryName,
        strategy: parsedSource.kind,
      },
    };
  }

  // 3. Not found.
  const declared = [
    ...own.map((e) => e.name),
    ...mounts.map((m) => `${m.name} (mount, ${m.mode})`),
  ];
  const listHint =
    declared.length > 0
      ? ` Declared stores: ${declared.join(", ")}.`
      : " No stores declared in workspace.yml.";
  return {
    ok: false,
    error: `memory '${memoryName}' is not declared in workspace '${workspaceId}'.${listHint} Add it to memory.own in workspace.yml.`,
  };
}
