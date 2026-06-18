import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { dec, enc, registerReconnectReset } from "jetstream";
import { type KV, type NatsConnection, StorageType } from "nats";
import { z } from "zod";

const logger = createLogger({ component: "tool-access-grants" });

const KV_BUCKET = "TOOL_ACCESS_GRANTS";
const HISTORY = 3;

export const ToolAccessGrantSchema = z.object({
  workspaceId: z.string(),
  /**
   * LLM-facing tool name as it was originally requested. May be qualified
   * (`serverId/bareName`) or bare. Stored as-given so `hasGrant` lookups
   * remain compatible with both call shapes; back-compat with grants
   * persisted before `serverId` existed depends on this stability.
   */
  toolName: z.string(),
  /**
   * Source workspace MCP server. Set going forward for qualified tool
   * names so `fsm-engine.buildTools` can eagerly load the server that
   * carries the granted tool. Legacy grants don't have this — the read
   * path infers it from the `toolName` shape when feasible.
   */
  serverId: z.string().optional(),
  scope: z.literal("workspace"),
  grantedAt: z.string().datetime({ offset: true }),
  sourceElicitationId: z.string().optional(),
  grantedBy: z.string().optional(),
});

export type ToolAccessGrant = z.infer<typeof ToolAccessGrantSchema>;

/**
 * Granted tool projection returned by `listForWorkspace`. `bareToolName`
 * is what `mcpResult.tools` is keyed by; `serverId` is the source MCP
 * server when known (set on new grants, inferred from qualified
 * `toolName` shape for legacy ones).
 */
export interface ListedGrant {
  /** Original LLM-facing name. */
  toolName: string;
  /** Bare tool name (post-`serverId/` strip). Matches `filtered` keys. */
  bareToolName: string;
  /** Source server when known; undefined if the grant predates `serverId`
   * and `toolName` is unqualified. */
  serverId?: string;
}

/**
 * Parse a tool name into `(serverId, bareToolName)`. Returns
 * `serverId === undefined` for bare names with no `/` separator.
 * Defensive against pathological inputs (leading/trailing slashes).
 */
function parseToolName(toolName: string): { serverId?: string; bareToolName: string } {
  const slash = toolName.indexOf("/");
  if (slash <= 0 || slash === toolName.length - 1) return { bareToolName: toolName };
  return { serverId: toolName.slice(0, slash), bareToolName: toolName.slice(slash + 1) };
}

function keySegment(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") || "00";
}

function grantKey(input: { workspaceId: string; toolName: string }): string {
  return `${keySegment(input.workspaceId)}.${keySegment(input.toolName)}`;
}

export class JetStreamToolAccessGrantAdapter {
  private cachedKv: KV | null = null;

  constructor(private readonly nc: NatsConnection) {
    registerReconnectReset(this.nc, () => {
      this.cachedKv = null;
    });
  }

  private async kv(): Promise<KV> {
    if (this.cachedKv) return this.cachedKv;
    const js = this.nc.jetstream();
    this.cachedKv = await js.views.kv(KV_BUCKET, { history: HISTORY, storage: StorageType.File });
    return this.cachedKv;
  }

  async grantAlways(input: {
    workspaceId: string;
    toolName: string;
    /**
     * Source MCP server for the granted tool. When omitted, derived from
     * `toolName` if it's qualified (`serverId/bareName`). Persisting the
     * server alongside the tool lets `fsm-engine.buildTools` eagerly
     * load the carrying MCP server on future actions, so a grant for
     * `gmail/send_email` works even when the action that benefits
     * doesn't declare gmail in its `tools:` array.
     */
    serverId?: string;
    sourceElicitationId?: string;
    grantedBy?: string;
  }): Promise<Result<ToolAccessGrant, string>> {
    try {
      const serverId = input.serverId ?? parseToolName(input.toolName).serverId;
      const grant: ToolAccessGrant = {
        workspaceId: input.workspaceId,
        toolName: input.toolName,
        scope: "workspace",
        grantedAt: new Date().toISOString(),
        ...(serverId ? { serverId } : {}),
        ...(input.sourceElicitationId ? { sourceElicitationId: input.sourceElicitationId } : {}),
        ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}),
      };
      const parsed = ToolAccessGrantSchema.parse(grant);
      const kv = await this.kv();
      await kv.put(grantKey(input), enc.encode(JSON.stringify(parsed)));
      return success(parsed);
    } catch (err) {
      logger.warn("Failed to persist tool access grant", {
        workspaceId: input.workspaceId,
        toolName: input.toolName,
        error: stringifyError(err),
      });
      return fail(stringifyError(err));
    }
  }

  async hasGrant(input: {
    workspaceId: string;
    toolName: string;
  }): Promise<Result<boolean, string>> {
    try {
      const kv = await this.kv();
      const entry = await kv.get(grantKey(input));
      if (!entry || entry.operation !== "PUT") return success(false);
      const parsed = ToolAccessGrantSchema.safeParse(JSON.parse(dec.decode(entry.value)));
      if (!parsed.success) return success(false);
      return success(
        parsed.data.workspaceId === input.workspaceId && parsed.data.toolName === input.toolName,
      );
    } catch (err) {
      return fail(stringifyError(err));
    }
  }

  async listForWorkspace(input: { workspaceId: string }): Promise<Result<ListedGrant[], string>> {
    try {
      const kv = await this.kv();
      const prefix = `${keySegment(input.workspaceId)}.`;
      // Drain keys before fetching values — `kv.get` inside `for await`
      // can terminate the keys iterator early in nats.js v2.29 (see the
      // matching note in jetstream-adapter.ts). Two-pass is safe.
      const keysIter = await kv.keys(`${keySegment(input.workspaceId)}.*`);
      const keys: string[] = [];
      for await (const key of keysIter) keys.push(key);
      const out: ListedGrant[] = [];
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const entry = await kv.get(key);
        if (!entry || entry.operation !== "PUT") continue;
        const parsed = ToolAccessGrantSchema.safeParse(JSON.parse(dec.decode(entry.value)));
        if (!parsed.success) continue;
        if (parsed.data.workspaceId !== input.workspaceId) continue;
        // Trust persisted `serverId` when present; otherwise infer from a
        // qualified `toolName`. Legacy grants with bare names stay with
        // `serverId: undefined` and fall back to bare-name matching in
        // consumers.
        const parsedShape = parseToolName(parsed.data.toolName);
        const serverId = parsed.data.serverId ?? parsedShape.serverId;
        out.push({
          toolName: parsed.data.toolName,
          bareToolName: parsedShape.bareToolName,
          ...(serverId ? { serverId } : {}),
        });
      }
      return success(out);
    } catch (err) {
      return fail(stringifyError(err));
    }
  }
}

let adapter: JetStreamToolAccessGrantAdapter | null = null;

export function initToolAccessGrantStorage(nc: NatsConnection): void {
  adapter = new JetStreamToolAccessGrantAdapter(nc);
}

export function resetToolAccessGrantStorageForTests(): void {
  adapter = null;
}

function requireAdapter(): JetStreamToolAccessGrantAdapter {
  if (!adapter) {
    throw new Error(
      "Tool access grant storage not initialized — call initElicitationStorage(nc) at daemon startup",
    );
  }
  return adapter;
}

export const ToolAccessGrants = {
  grantAlways: (input: {
    workspaceId: string;
    toolName: string;
    serverId?: string;
    sourceElicitationId?: string;
    grantedBy?: string;
  }): Promise<Result<ToolAccessGrant, string>> => requireAdapter().grantAlways(input),
  hasGrant: (input: { workspaceId: string; toolName: string }): Promise<Result<boolean, string>> =>
    requireAdapter().hasGrant(input),
  listForWorkspace: (input: { workspaceId: string }): Promise<Result<ListedGrant[], string>> =>
    requireAdapter().listForWorkspace(input),
};

export async function bootstrapToolAccessGrantStorage(nc: NatsConnection): Promise<void> {
  const js = nc.jetstream();
  await js.views.kv(KV_BUCKET, { history: HISTORY, storage: StorageType.File });
}
