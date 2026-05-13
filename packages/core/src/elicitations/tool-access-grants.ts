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
  toolName: z.string(),
  scope: z.literal("workspace"),
  grantedAt: z.string().datetime({ offset: true }),
  sourceElicitationId: z.string().optional(),
  grantedBy: z.string().optional(),
});

export type ToolAccessGrant = z.infer<typeof ToolAccessGrantSchema>;

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
    sourceElicitationId?: string;
    grantedBy?: string;
  }): Promise<Result<ToolAccessGrant, string>> {
    try {
      const grant: ToolAccessGrant = {
        workspaceId: input.workspaceId,
        toolName: input.toolName,
        scope: "workspace",
        grantedAt: new Date().toISOString(),
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

  async listForWorkspace(input: { workspaceId: string }): Promise<Result<string[], string>> {
    try {
      const kv = await this.kv();
      const prefix = `${keySegment(input.workspaceId)}.`;
      // Drain keys before fetching values — `kv.get` inside `for await`
      // can terminate the keys iterator early in nats.js v2.29 (see the
      // matching note in jetstream-adapter.ts). Two-pass is safe.
      const keysIter = await kv.keys(`${keySegment(input.workspaceId)}.*`);
      const keys: string[] = [];
      for await (const key of keysIter) keys.push(key);
      const out: string[] = [];
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const entry = await kv.get(key);
        if (!entry || entry.operation !== "PUT") continue;
        const parsed = ToolAccessGrantSchema.safeParse(JSON.parse(dec.decode(entry.value)));
        if (!parsed.success) continue;
        if (parsed.data.workspaceId !== input.workspaceId) continue;
        out.push(parsed.data.toolName);
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
    sourceElicitationId?: string;
    grantedBy?: string;
  }): Promise<Result<ToolAccessGrant, string>> => requireAdapter().grantAlways(input),
  hasGrant: (input: { workspaceId: string; toolName: string }): Promise<Result<boolean, string>> =>
    requireAdapter().hasGrant(input),
  listForWorkspace: (input: { workspaceId: string }): Promise<Result<string[], string>> =>
    requireAdapter().listForWorkspace(input),
};

export async function bootstrapToolAccessGrantStorage(nc: NatsConnection): Promise<void> {
  const js = nc.jetstream();
  await js.views.kv(KV_BUCKET, { history: HISTORY, storage: StorageType.File });
}
