import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "@std/yaml";
import { z } from "zod";

const HashStringSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const PrimitivePinSchema = z.object({ hash: HashStringSchema, path: z.string().min(1) });

const SnapshotPinSchema = z.object({
  backend: z.string().min(1),
  digest: HashStringSchema,
  path: z.string().min(1),
});

const ResourcePinSchema = z.object({ digest: HashStringSchema, path: z.string().min(1) });

const PlatformDepsSchema = z.object({
  daemon: z.string().optional(),
  atlasAgents: z.record(z.string(), z.string()).optional(),
  modelProviders: z.array(z.string()).optional(),
});

const WorkspaceIdentitySchema = z.object({ name: z.string().min(1), version: z.string().min(1) });

export const LockfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["definition", "migration"]),
    workspace: WorkspaceIdentitySchema,
    platformDeps: PlatformDepsSchema.optional(),
    primitives: z
      .object({
        skills: z.record(z.string(), PrimitivePinSchema).default({}),
        agents: z.record(z.string(), PrimitivePinSchema).default({}),
      })
      .default({ skills: {}, agents: {} }),
    snapshots: z
      .object({
        memory: z.record(z.string(), SnapshotPinSchema).default({}),
        resources: z.record(z.string(), ResourcePinSchema).default({}),
        history: z.unknown().nullable().default(null),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "definition" && value.snapshots !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "definition-mode lockfile must not contain a snapshots section",
        path: ["snapshots"],
      });
    }
    if (value.mode === "migration" && value.snapshots === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "migration-mode lockfile must contain a snapshots section",
        path: ["snapshots"],
      });
    }
  });

export type Lockfile = z.infer<typeof LockfileSchema>;

export async function readLockfile(path: string): Promise<Lockfile> {
  const yaml = await readFile(path, "utf-8");
  const parsed: unknown = parse(yaml);
  return LockfileSchema.parse(parsed);
}

export async function writeLockfile(path: string, lockfile: Lockfile): Promise<void> {
  const validated = LockfileSchema.parse(lockfile);
  const yaml = stringify(validated as Record<string, unknown>, { lineWidth: 100 });
  await writeFile(path, yaml, "utf-8");
}
