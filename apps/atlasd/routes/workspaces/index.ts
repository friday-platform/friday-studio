import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { WorkspaceConfig } from "@atlas/config";
import { WorkspaceConfigSchema } from "@atlas/config";
import {
  applyMutation,
  type CredentialUsage,
  deleteSignal,
  extractCredentials,
  stripCredentialRefs,
  toIdRefs,
  toProviderRefs,
} from "@atlas/config/mutations";
import {
  MissingEnvironmentError,
  SessionFailedError,
  UserConfigurationError,
  WorkspaceNotFoundError,
} from "@atlas/core";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import {
  CredentialNotFoundError,
  deleteSlackApp,
  fetchLinkCredential,
  InvalidProviderError,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  resolveCredentialsByProvider,
  resolveSlackAppByWorkspace,
} from "@atlas/core/mcp-registry/credential-resolver";
import type { ResourceMetadata, ResourceVersion } from "@atlas/ledger";
import { createLogger, logger } from "@atlas/logger";
import { createLedgerClient } from "@atlas/resources";
import { resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import { FilesystemWorkspaceCreationAdapter } from "@atlas/storage";
import { ColorSchema, isErrnoException, stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { stringify } from "@std/yaml";
import { z } from "zod";
import { daemonFactory, KERNEL_WORKSPACE_ID } from "../../src/factory.ts";
import {
  createLinkUnwiredClient,
  createLinkWireClient,
  disableSlackEventSubscriptions,
  enableSlackEventSubscriptions,
  slackSignalMutation,
  tryAutoWireSlackApp,
} from "../../src/services/slack-auto-wire.ts";
import { getCurrentUser } from "../me/adapter.ts";
import { applyBlueprint, loadWorkspaceBlueprint } from "./blueprint-recompile.ts";
import { mapMutationError } from "./mutation-errors.ts";
import { resourceRoutes } from "./resources.ts";
import {
  addWorkspaceBatchSchema,
  addWorkspaceSchema,
  createWorkspaceFromConfigSchema,
  updateWorkspaceConfigSchema,
} from "./schemas.ts";

const analytics = createAnalyticsClient();

/** Shared schemas for the signal endpoint (SSE + JSON handlers). */
const signalParamSchema = z.object({ workspaceId: z.string(), signalId: z.string() });
const signalBodySchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
  streamId: z.string().optional(),
  skipStates: z.array(z.string()).optional(),
});

export * from "./schemas.ts";

/** Format a job key into a display name: title > formatted key > raw key */
export function formatJobName(
  key: string,
  job: { title?: string; [key: string]: unknown },
): string {
  if (job.title) return job.title;
  const formatted = key.replace(/[-_]/g, " ");
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/**
 * Extract integration provider names for a specific job by tracing:
 * - LLM actions: tools (MCP server IDs) → credential paths → providers
 * - Agent actions: agentId → bundled agent registry → requiredConfig link providers
 */
export function extractJobIntegrations(
  job: {
    fsm?: {
      states?: Record<
        string,
        { entry?: Array<{ type: string; tools?: string[]; agentId?: string }> }
      >;
    };
  },
  config: WorkspaceConfig,
): string[] {
  const states = job.fsm?.states;
  if (!states) return [];

  const serverIds = new Set<string>();
  const agentIds = new Set<string>();

  for (const state of Object.values(states)) {
    for (const action of state.entry ?? []) {
      if (action.type === "llm" && action.tools) {
        for (const t of action.tools) serverIds.add(t);
      } else if (action.type === "agent" && action.agentId) {
        agentIds.add(action.agentId);
      }
    }
  }

  const providers = new Set<string>();

  // LLM tools → MCP server credentials → providers
  if (serverIds.size > 0) {
    const credentials = extractCredentials(config);
    for (const cred of credentials) {
      const [type, entityId] = cred.path.split(":");
      if (!cred.provider || !entityId) continue;
      if (type === "mcp" && serverIds.has(entityId)) {
        providers.add(cred.provider);
      }
    }
  }

  // Bundled agent IDs → registry requiredConfig link providers
  for (const agentId of agentIds) {
    const entry = bundledAgentsRegistry[agentId];
    if (!entry) continue;
    for (const field of entry.requiredConfig) {
      if (field.from === "link") {
        providers.add(field.provider);
      }
    }
  }

  return [...providers];
}

/**
 * Inject missing `from: link` credential refs from the bundled agent registry.
 * When a workspace uses a bundled atlas agent but the user hasn't configured
 * its required OAuth credentials, the agent's env block is empty/missing.
 * This ensures those refs are present so the credential extraction flow
 * can detect and resolve them during export/import.
 */
export function injectBundledAgentRefs(config: WorkspaceConfig): WorkspaceConfig {
  const agents = config.agents;
  if (!agents) return config;

  let needsUpdate = false;
  const updatedAgents: Record<string, (typeof agents)[string]> = {};

  for (const [id, agent] of Object.entries(agents)) {
    if (agent.type !== "atlas") {
      updatedAgents[id] = agent;
      continue;
    }

    const entry = bundledAgentsRegistry[agent.agent];
    if (!entry) {
      updatedAgents[id] = agent;
      continue;
    }

    const missingRefs: Record<string, { from: "link"; provider: string; key: string }> = {};
    for (const field of entry.requiredConfig) {
      if (field.from !== "link") continue;
      if (agent.env?.[field.envKey]) continue;
      missingRefs[field.envKey] = { from: "link", provider: field.provider, key: field.key };
    }

    if (Object.keys(missingRefs).length === 0) {
      updatedAgents[id] = agent;
      continue;
    }

    needsUpdate = true;
    updatedAgents[id] = { ...agent, env: { ...agent.env, ...missingRefs } };
  }

  if (!needsUpdate) return config;
  return { ...config, agents: updatedAgents };
}

// Zod schemas for parsing Ledger version data per resource type.
// Ledger stores schema/data as `unknown` — parse here instead of casting.
const ProseSchemaShape = z.object({ type: z.literal("string"), format: z.literal("markdown") });
const DocumentSchemaShape = z.record(z.string(), z.unknown());
const ArtifactRefDataShape = z.object({ artifact_id: z.string() });
const ExternalRefDataShape = z.object({
  provider: z.string(),
  ref: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Reconstruct a resource declaration from Ledger metadata + version data.
 * Prose resources are stored as type "document" with a markdown schema —
 * detect by checking the schema shape.
 */
export function toConfigResourceDeclaration(
  metadata: ResourceMetadata,
  version: ResourceVersion,
): NonNullable<WorkspaceConfig["resources"]>[number] {
  const base = { slug: metadata.slug, name: metadata.name, description: metadata.description };

  switch (metadata.type) {
    case "document": {
      const schemaResult = DocumentSchemaShape.safeParse(version.schema);
      const schema = schemaResult.success ? schemaResult.data : {};
      if (ProseSchemaShape.safeParse(schema).success) {
        return { type: "prose" as const, ...base };
      }
      return { type: "document" as const, ...base, schema };
    }
    case "artifact_ref": {
      const parsed = ArtifactRefDataShape.safeParse(version.data);
      return {
        type: "artifact_ref" as const,
        ...base,
        artifactId: parsed.success ? parsed.data.artifact_id : "",
      };
    }
    case "external_ref": {
      const parsed = ExternalRefDataShape.safeParse(version.data);
      if (!parsed.success) {
        return { type: "external_ref" as const, ...base, provider: "" };
      }
      return {
        type: "external_ref" as const,
        ...base,
        provider: parsed.data.provider,
        ...(parsed.data.ref !== undefined && { ref: parsed.data.ref }),
        ...(parsed.data.metadata !== undefined && { metadata: parsed.data.metadata }),
      };
    }
  }
}

/**
 * Provision resources from workspace config into Ledger.
 * Maps config-level resource declarations to Ledger provision calls.
 */
export async function provisionConfigResources(
  workspaceId: string,
  userId: string,
  resources: NonNullable<WorkspaceConfig["resources"]>,
  provisionLogger: ReturnType<typeof createLogger>,
): Promise<string[]> {
  const ledger = createLedgerClient();
  const errors: string[] = [];

  for (const resource of resources) {
    try {
      let ledgerType: "document" | "artifact_ref" | "external_ref";
      let schema: unknown;
      let initialData: unknown;

      switch (resource.type) {
        case "document":
          ledgerType = "document";
          schema = resource.schema;
          initialData = [];
          break;
        case "prose":
          ledgerType = "document";
          schema = { type: "string", format: "markdown" };
          initialData = "";
          break;
        case "artifact_ref":
          ledgerType = "artifact_ref";
          schema = {};
          initialData = { artifact_id: resource.artifactId };
          break;
        case "external_ref":
          ledgerType = "external_ref";
          schema = {};
          initialData = {
            provider: resource.provider,
            ...(resource.ref !== undefined && { ref: resource.ref }),
            ...(resource.metadata !== undefined && { metadata: resource.metadata }),
          };
          break;
      }

      await ledger.provision(
        workspaceId,
        {
          userId,
          slug: resource.slug,
          name: resource.name,
          description: resource.description,
          type: ledgerType,
          schema,
        },
        initialData,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      provisionLogger.warn("Failed to provision resource", { slug: resource.slug, error: message });
      errors.push(`${resource.slug}: ${message}`);
    }
  }

  return errors;
}

// Create and mount routes
const workspacesRoutes = daemonFactory
  .createApp()
  // List all workspaces
  .get("/", async (c) => {
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const allWorkspaces = await manager.list({ includeSystem: true });
      const workspaces = ctx.exposeKernel
        ? allWorkspaces
        : allWorkspaces.filter((w) => w.id !== KERNEL_WORKSPACE_ID);
      const response = workspaces
        .map((w) => ({
          ...w,
          description: w.metadata?.description,
          type: w.metadata?.ephemeral ? "ephemeral" : "persistent",
          canonical: w.metadata?.canonical,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      return c.json(response);
    } catch (error) {
      return c.json({ error: `Failed to list workspaces: ${stringifyError(error)}` }, 500);
    }
  })
  // Create workspace from configuration
  .post("/create", zValidator("json", createWorkspaceFromConfigSchema), async (c) => {
    try {
      const { config, workspaceName, ephemeral } = c.req.valid("json");

      // Validate configuration
      const validationResult = WorkspaceConfigSchema.safeParse(config);
      if (!validationResult.success) {
        return c.json(
          {
            success: false,
            error: `Invalid workspace configuration: ${validationResult.error.issues
              .map((issue) => issue.message)
              .join(", ")}`,
          },
          400,
        );
      }

      let validatedConfig = validationResult.data;

      // Inject missing credential refs from bundled agent registry so that
      // agents requiring OAuth credentials are detected during import.
      validatedConfig = injectBundledAgentRefs(validatedConfig);

      // Preprocess id-only credential refs (from foreign/legacy workspace files).
      // Try to fetch each to discover the provider. If the credential belongs to the
      // current user, convert to a provider-only ref so the normal resolution flow
      // re-binds it. If the credential is foreign/deleted (404), strip the env var
      // so the workspace can still be created.
      const importLogger = createLogger({ component: "workspace-import" });
      const initialCredentials = extractCredentials(validatedConfig);
      const idOnlyRefs = initialCredentials.filter(
        (cred): cred is CredentialUsage & { credentialId: string } =>
          !!cred.credentialId && !cred.provider,
      );

      let strippedCredentialPaths: string[] | undefined;
      let unresolvedCredentialPaths: string[] | undefined;

      if (idOnlyRefs.length > 0) {
        const lookupResults = await Promise.allSettled(
          idOnlyRefs.map(async (ref) => {
            const credential = await fetchLinkCredential(ref.credentialId, importLogger);
            return { credentialId: ref.credentialId, provider: credential.provider };
          }),
        );

        const pathsToStrip: string[] = [];
        const idProviderMap: Record<string, string> = {};
        const expiredCredentials: Array<{ credentialId: string; path: string; status: string }> =
          [];

        for (const [i, result] of lookupResults.entries()) {
          const ref = idOnlyRefs[i];
          if (!ref) continue;
          if (result.status === "fulfilled") {
            idProviderMap[result.value.credentialId] = result.value.provider;
          } else if (result.reason instanceof LinkCredentialNotFoundError) {
            pathsToStrip.push(ref.path);
          } else if (result.reason instanceof LinkCredentialExpiredError) {
            expiredCredentials.push({
              credentialId: result.reason.credentialId,
              path: ref.path,
              status: result.reason.status,
            });
          } else {
            throw result.reason;
          }
        }

        if (expiredCredentials.length > 0) {
          return c.json(
            {
              error: "credential_expired",
              message:
                "Some credentials have expired. Re-authorize the integrations and try again.",
              expiredCredentials,
            },
            400,
          );
        }

        // Strip unresolvable refs (foreign/deleted credentials)
        if (pathsToStrip.length > 0) {
          importLogger.warn("Stripping unresolvable credential refs during import", {
            paths: pathsToStrip,
          });
          validatedConfig = stripCredentialRefs(validatedConfig, pathsToStrip);
          strippedCredentialPaths = pathsToStrip;
        }

        // Convert resolvable id-only refs to provider-only format so the
        // normal provider resolution flow re-binds them to the importing user
        if (Object.keys(idProviderMap).length > 0) {
          validatedConfig = toProviderRefs(validatedConfig, idProviderMap);
        }
      }

      // Re-extract credentials from the (potentially modified) config
      const credentials = extractCredentials(validatedConfig);
      const providerOnlyRefs = credentials.filter(
        (cred): cred is CredentialUsage & { provider: string } => !!cred.provider,
      );
      const allProviders = [...new Set(providerOnlyRefs.map((ref) => ref.provider))];

      // slack-app credentials are 1:1 with workspaces — never auto-resolve from the
      // generic pool. Always require a fresh bot install via the setup flow.
      const uniqueProviders = allProviders.filter((p) => p !== "slack-app");
      const hasSlackApp = allProviders.includes("slack-app");

      type ResolvedCredentialInfo = {
        path: string;
        provider: string;
        credentialId: string;
        label: string;
      };
      let resolvedCredentials: ResolvedCredentialInfo[] | undefined;
      const unresolvedProviders: string[] = [];
      let ambiguousProviders:
        | Record<
            string,
            Array<{
              id: string;
              label: string;
              displayName: string | null;
              userIdentifier: string | null;
              isDefault: boolean;
            }>
          >
        | undefined;
      const invalidProviders: string[] = [];

      if (uniqueProviders.length > 0) {
        const results = await Promise.allSettled(
          uniqueProviders.map((provider) => resolveCredentialsByProvider(provider)),
        );

        const credentialMap: Record<string, string> = {};
        const labelMap: Record<string, string> = {};

        for (const [i, result] of results.entries()) {
          const provider = uniqueProviders[i] ?? "";
          if (result.status === "rejected") {
            if (result.reason instanceof InvalidProviderError) {
              invalidProviders.push(provider);
            } else if (result.reason instanceof CredentialNotFoundError) {
              unresolvedProviders.push(provider);
            } else {
              throw result.reason;
            }
          } else if (result.value.length === 1) {
            const first = result.value[0];
            if (first) {
              credentialMap[provider] = first.id;
              labelMap[provider] = first.label;
            }
          } else if (result.value.length > 1) {
            // Multiple credentials — surface ambiguity for the picker UI
            ambiguousProviders ??= {};
            ambiguousProviders[provider] = result.value.map((cred) => ({
              id: cred.id,
              label: cred.label,
              displayName: cred.displayName,
              userIdentifier: cred.userIdentifier,
              isDefault: cred.isDefault,
            }));
          }
        }

        if (invalidProviders.length > 0) {
          return c.json(
            {
              error: "missing_providers",
              message: "Cannot import workspace: required providers are not configured",
              providers: invalidProviders,
            },
            400,
          );
        }

        // Track unresolved provider refs for requires_setup flag, but keep them
        // in the config — they're declarative requirements the setup page needs
        // to show Connect buttons for MCP server credentials.
        if (unresolvedProviders.length > 0) {
          unresolvedCredentialPaths = providerOnlyRefs
            .filter((ref) => unresolvedProviders.includes(ref.provider))
            .map((ref) => ref.path);
        }

        // Apply credential IDs only for single-match providers (ambiguous excluded from map)
        validatedConfig = toIdRefs(validatedConfig, credentialMap);

        resolvedCredentials = providerOnlyRefs
          .filter((ref) => credentialMap[ref.provider])
          .map((ref) => ({
            path: ref.path,
            provider: ref.provider,
            credentialId: credentialMap[ref.provider] ?? "",
            label: labelMap[ref.provider] ?? "",
          }));
      }

      // slack-app credentials are 1:1 with workspaces — always require fresh
      // bot install via setup flow, regardless of existing credentials.
      if (hasSlackApp) {
        unresolvedProviders.push("slack-app");
      }

      const yamlConfig = stringify(validatedConfig, { indent: 2, lineWidth: 100 });

      const workspaceAdapter = new FilesystemWorkspaceCreationAdapter();
      const finalWorkspaceName = workspaceName || validatedConfig.workspace.name;
      const basePath = join(getAtlasHome(), "workspaces");

      try {
        const workspacePath = await workspaceAdapter.createWorkspaceDirectory(
          basePath,
          finalWorkspaceName,
        );

        await workspaceAdapter.writeWorkspaceFiles(workspacePath, yamlConfig, { ephemeral });

        // Get current user for analytics and metadata
        const userResult = await getCurrentUser();
        const userId = userResult.ok ? userResult.data?.id : undefined;

        // Register workspace with manager
        const ctx = c.get("app");
        const manager = ctx.daemon.getWorkspaceManager();
        const hasUnresolvedCredentials =
          unresolvedProviders.length > 0 ||
          ambiguousProviders !== undefined ||
          (strippedCredentialPaths !== undefined && strippedCredentialPaths.length > 0) ||
          (unresolvedCredentialPaths !== undefined && unresolvedCredentialPaths.length > 0);
        const { workspace, created } = await manager.registerWorkspace(workspacePath, {
          name: finalWorkspaceName,
          description: validatedConfig.workspace.description,
          createdBy: userId,
          skipEnvValidation: hasUnresolvedCredentials,
        });

        // Set requires_setup flag if any credentials are missing or were stripped
        if (hasUnresolvedCredentials && created) {
          await manager.updateWorkspaceStatus(workspace.id, workspace.status, {
            metadata: { ...workspace.metadata, requires_setup: true },
          });
          workspace.metadata = { ...workspace.metadata, requires_setup: true };
        }

        // Emit workspace.created analytics event for new workspaces
        if (created && userId) {
          analytics.emit({
            eventName: EventNames.WORKSPACE_CREATED,
            userId,
            workspaceId: workspace.id,
          });
        }

        // Best-effort Slack auto-wire: find unwired slack-app credential, wire it,
        // and inject a provider: "slack" signal into the workspace config.
        // Skip when slack-app refs are present — those require a fresh bot install
        // via the setup flow, not reuse of an existing credential.
        let slackWired: { credentialId: string; appId: string } | undefined;
        if (!hasSlackApp) {
          try {
            const wireResult = await tryAutoWireSlackApp(
              { findUnwired: createLinkUnwiredClient(), wireToWorkspace: createLinkWireClient() },
              workspace.id,
              finalWorkspaceName,
              validatedConfig.workspace.description,
            );
            if (wireResult) {
              slackWired = wireResult;
              await applyMutation(workspacePath, slackSignalMutation(wireResult.appId));
              await enableSlackEventSubscriptions(wireResult.credentialId);
            }
          } catch (wireError) {
            logger.warn("Slack auto-wire failed during workspace creation", {
              workspaceId: workspace.id,
              error: stringifyError(wireError),
            });
          }
        }

        // Provision resources declared in the imported config
        let resourceErrors: string[] | undefined;
        if (validatedConfig.resources && validatedConfig.resources.length > 0 && created) {
          const importResourceLogger = createLogger({ component: "workspace-import-resources" });
          const provisionUserId = userId ?? "local";
          const errors = await provisionConfigResources(
            workspace.id,
            provisionUserId,
            validatedConfig.resources,
            importResourceLogger,
          );
          if (errors.length > 0) {
            resourceErrors = errors;
          }
        }

        return c.json(
          {
            success: true,
            workspace,
            created,
            workspacePath,
            filesCreated: [ephemeral ? "eph_workspace.yml" : "workspace.yml", ".env"],
            ...(resolvedCredentials && resolvedCredentials.length > 0
              ? { resolvedCredentials }
              : {}),
            ...(ambiguousProviders ? { ambiguousProviders } : {}),
            ...(strippedCredentialPaths && strippedCredentialPaths.length > 0
              ? { strippedCredentials: strippedCredentialPaths }
              : {}),
            ...(slackWired ? { slackWired } : {}),
            ...(unresolvedCredentialPaths && unresolvedCredentialPaths.length > 0
              ? { unresolvedCredentials: unresolvedCredentialPaths }
              : {}),
            ...(resourceErrors && resourceErrors.length > 0 ? { resourceErrors } : {}),
          },
          201,
        );
      } catch (creationError) {
        return c.json(
          {
            success: false,
            error: `Failed to create workspace files: ${
              creationError instanceof Error ? creationError.message : String(creationError)
            }`,
          },
          500,
        );
      }
    } catch (error) {
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  })
  // Add a single workspace by path
  .post("/add", zValidator("json", addWorkspaceSchema), async (c) => {
    const ctx = c.get("app");
    try {
      const { path, name, description } = c.req.valid("json");

      // Get current user for analytics and metadata
      const userResult = await getCurrentUser();
      const userId = userResult.ok ? userResult.data?.id : undefined;

      const manager = ctx.daemon.getWorkspaceManager();

      const { workspace: entry, created } = await manager.registerWorkspace(path, {
        name,
        description,
        createdBy: userId,
      });

      // Emit workspace.created analytics event for new workspaces
      if (created && userId) {
        analytics.emit({ eventName: EventNames.WORKSPACE_CREATED, userId, workspaceId: entry.id });
      }

      // Best-effort Slack auto-wire
      let slackWired: { credentialId: string; appId: string } | undefined;
      try {
        const wireResult = await tryAutoWireSlackApp(
          { findUnwired: createLinkUnwiredClient(), wireToWorkspace: createLinkWireClient() },
          entry.id,
          name ?? entry.name,
          description,
        );
        if (wireResult) {
          slackWired = wireResult;
          await applyMutation(path, slackSignalMutation(wireResult.appId));
          await enableSlackEventSubscriptions(wireResult.credentialId);
        }
      } catch (wireError) {
        logger.warn("Slack auto-wire failed during workspace add", {
          workspaceId: entry.id,
          error: stringifyError(wireError),
        });
      }

      // Convert to API response format
      const workspaceInfo = {
        id: entry.id,
        name: entry.name,
        description: entry.metadata?.description,
        status: entry.status,
        path: entry.path,
        createdAt: entry.createdAt,
        lastSeen: entry.lastSeen,
        created,
        ...(slackWired ? { slackWired } : {}),
      };

      return c.json(workspaceInfo, created ? 201 : 200);
    } catch (error) {
      const message = stringifyError(error);
      logger.error("Failed to add workspace", { error: message });
      // Treat registration errors as bad requests (invalid path/config)
      if (message) return c.json({ error: message }, 400);
      return c.json({ error: `Failed to add workspace: ${message}` }, 500);
    }
  })
  // Add multiple workspaces by paths (batch operation)
  .post("/add-batch", zValidator("json", addWorkspaceBatchSchema), async (c) => {
    const ctx = c.get("app");
    try {
      const { paths } = c.req.valid("json");

      const manager = ctx.daemon.getWorkspaceManager();
      const results: {
        added: Array<{
          id: string;
          name: string;
          description?: string;
          status: string;
          path: string;
          createdAt: string;
          lastSeen: string;
          created: boolean;
        }>;
        failed: Array<{ path: string; error: string }>;
      } = { added: [], failed: [] };

      // Process paths with reasonable concurrency (5 parallel)
      const batchSize = 5;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const batchPromises = batch.map(async (path) => {
          try {
            const { workspace: entry, created } = await manager.registerWorkspace(path);

            results.added.push({
              id: entry.id,
              name: entry.name,
              description: entry.metadata?.description,
              status: entry.status,
              path: entry.path,
              createdAt: entry.createdAt,
              lastSeen: entry.lastSeen,
              created,
            });
          } catch (error) {
            results.failed.push({ path, error: stringifyError(error) });
          }
        });

        await Promise.all(batchPromises);
      }

      return c.json(results, 200);
    } catch (error) {
      logger.error("Failed to add workspaces", { error });
      return c.json({ error: "Failed to add workspaces" }, 500);
    }
  })
  // Get workspace details
  .get("/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace =
        (await manager.find({ id: workspaceId })) || (await manager.find({ name: workspaceId }));
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      // Load workspace configuration
      const config = await manager.getWorkspaceConfig(workspace.id);

      return c.json(
        {
          ...workspace,
          description: workspace.metadata?.description,
          type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
          config: config?.workspace || null,
        },
        200,
      );
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to get workspace: ${errorMessage}` }, 500);
    }
  })
  // Export workspace configuration as YAML
  .get("/:workspaceId/export", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const exportLogger = createLogger({ component: "workspace-export" });
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }

      // Fetch resource declarations from Ledger to include in the export.
      // Resources are stored in Ledger (not workspace.yml), so we reconstruct
      // declarations from metadata + published version data.
      let exportResources: NonNullable<WorkspaceConfig["resources"]> | undefined;
      try {
        const ledger = createLedgerClient();
        const metadataList = await ledger.listResources(workspaceId);
        if (metadataList.length > 0) {
          const withData = await Promise.all(
            metadataList.map(async (meta) => {
              const full = await ledger.getResource(workspaceId, meta.slug, { published: true });
              return { metadata: meta, version: full?.version };
            }),
          );
          exportResources = withData
            .filter(
              (r): r is { metadata: ResourceMetadata; version: ResourceVersion } => !!r.version,
            )
            .map((r) => toConfigResourceDeclaration(r.metadata, r.version));
        }
      } catch (resourceError) {
        exportLogger.warn("Failed to fetch resources for export, continuing without them", {
          error: stringifyError(resourceError),
        });
      }

      // Inject missing credential refs from bundled agent registry so they
      // appear in the exported YAML even if the user never configured them.
      const configWithAgentRefs = injectBundledAgentRefs(config.workspace);

      const credentials = extractCredentials(configWithAgentRefs);
      const legacyRefs = credentials.filter(
        (cred): cred is CredentialUsage & { credentialId: string } =>
          !cred.provider && !!cred.credentialId,
      );

      const providerMap: Record<string, string> = {};
      const unresolvedPaths: string[] = [];

      const legacyResults = await Promise.allSettled(
        legacyRefs.map(async (ref) => {
          const credential = await fetchLinkCredential(ref.credentialId, exportLogger);
          return { credentialId: ref.credentialId, provider: credential.provider, path: ref.path };
        }),
      );

      for (const [i, result] of legacyResults.entries()) {
        const ref = legacyRefs[i];
        if (!ref) continue;
        if (result.status === "fulfilled") {
          providerMap[result.value.credentialId] = result.value.provider;
        } else if (
          result.reason instanceof LinkCredentialNotFoundError ||
          result.reason instanceof LinkCredentialExpiredError
        ) {
          unresolvedPaths.push(ref.path);
        } else {
          throw result.reason;
        }
      }

      // Strip unresolvable legacy refs instead of failing the export.
      // The exported YAML will omit those env vars; the importing user
      // will need to configure credentials through workspace settings.
      let workspaceToExport = configWithAgentRefs;
      if (unresolvedPaths.length > 0) {
        exportLogger.warn("Stripping unresolvable credential refs from export", {
          unresolvedPaths,
        });
        workspaceToExport = stripCredentialRefs(workspaceToExport, unresolvedPaths);
      }

      const portableConfig = toProviderRefs(workspaceToExport, providerMap);

      // Strip workspace.id - it will be regenerated on import
      const { id: _id, ...workspaceIdentity } = portableConfig.workspace;
      const exportConfig = {
        ...portableConfig,
        workspace: workspaceIdentity,
        ...(exportResources && exportResources.length > 0 && { resources: exportResources }),
      };

      const yamlContent = stringify(exportConfig, { indent: 2, lineWidth: 100 });

      // Sanitize workspace name for filename
      const sanitizedName = workspace.name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-");
      const filename = `${sanitizedName}.yml`;

      return new Response(yamlContent, {
        headers: {
          "Content-Type": "text/yaml",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to export workspace: ${errorMessage}` }, 500);
    }
  })
  // Get workspace configuration
  .get("/:workspaceId/config", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const ctx = c.get("app");
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json({ error: `Failed to load workspace configuration: ${workspace.id}` }, 500);
      }
      return c.json({
        config: config.workspace,
        type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
        expiresAt: workspace.metadata?.expiresAt,
      });
    } catch (error) {
      const errorMessage = stringifyError(error);
      if (errorMessage.includes("not found")) {
        return c.json({ error: errorMessage }, 404);
      }
      return c.json({ error: `Failed to get workspace config: ${errorMessage}` }, 500);
    }
  })
  // Update workspace configuration
  .post(
    "/:workspaceId/update",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", updateWorkspaceConfigSchema),
    async (c) => {
      try {
        const { workspaceId } = c.req.valid("param");
        const { config, backup, force } = c.req.valid("json");

        const ctx = c.get("app");
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ success: false, error: `Workspace not found: ${workspaceId}` }, 400);
        }

        // Active-session guard. Refuse to destroy a runtime mid-session unless
        // the caller explicitly passes force=true. Matches the failure mode
        // documented in the FAST self-modification skill: operator edits
        // workspace.yml while a session is running, runtime tears down,
        // session dies with "MCP error -32000: Connection closed".
        if (!force) {
          const currentRuntime = ctx.getWorkspaceRuntime(workspaceId);
          if (currentRuntime) {
            const sessions = currentRuntime.getSessions();
            const activeSessions = sessions.filter(
              (s: { session: { status: string; id: string } }) => s.session.status === "active",
            );
            let hasActiveExecutions = false;
            if (
              "getOrchestrator" in currentRuntime &&
              typeof currentRuntime.getOrchestrator === "function"
            ) {
              const orchestrator = currentRuntime.getOrchestrator();
              hasActiveExecutions = orchestrator.hasActiveExecutions();
            }
            if (activeSessions.length > 0 || hasActiveExecutions) {
              return c.json(
                {
                  success: false,
                  error:
                    "Workspace has active sessions or executions. Pass force=true to override.",
                  activeSessionIds: activeSessions.map(
                    (s: { session: { id: string } }) => s.session.id,
                  ),
                  hasActiveExecutions,
                },
                409,
              );
            }
          }
        }

        const validationResult = WorkspaceConfigSchema.safeParse(config);
        if (!validationResult.success) {
          return c.json(
            {
              success: false,
              error: `Invalid workspace configuration: ${validationResult.error.issues
                .map((issue) => issue.message)
                .join(", ")}`,
            },
            400,
          );
        }

        const validatedConfig = validationResult.data;
        const yamlConfig = stringify(validatedConfig, { indent: 2, lineWidth: 100 });
        const workspacePath = workspace.path;
        const workspaceYmlPath = join(workspacePath, "workspace.yml");

        try {
          if (backup) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupPath = join(workspacePath, `workspace.yml.backup-${timestamp}`);
            try {
              const existingContent = await readFile(workspaceYmlPath, "utf-8");
              await writeFile(backupPath, existingContent, "utf-8");
            } catch (backupError) {
              return c.json(
                {
                  success: false,
                  error: `Failed to create backup: ${
                    backupError instanceof Error ? backupError.message : String(backupError)
                  }`,
                },
                500,
              );
            }
          }

          await writeFile(workspaceYmlPath, yamlConfig, "utf-8");

          const runtime = ctx.getWorkspaceRuntime(workspace.id);
          if (runtime) {
            await ctx.destroyWorkspaceRuntime(workspace.id);
            return c.json({
              success: true,
              workspace,
              runtimeReloaded: true,
              runtimeDestroyed: true,
            });
          }

          return c.json({
            success: true,
            workspace,
            runtimeReloaded: false,
            message: "No active runtime",
          });
        } catch (updateError) {
          return c.json(
            {
              success: false,
              error: `Failed to update workspace files: ${
                updateError instanceof Error ? updateError.message : String(updateError)
              }`,
            },
            500,
          );
        }
      } catch (error) {
        return c.json({ success: false, error: stringifyError(error) }, 500);
      }
    },
  )
  // Toggle persistence
  .post(
    "/:workspaceId/persistence",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", z.object({ persistent: z.boolean() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { persistent } = c.req.valid("json");
      const ctx = c.get("app");
      try {
        const manager = ctx.getWorkspaceManager();
        await manager.updateWorkspacePersistence(workspaceId, persistent);
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        return c.json({
          ...workspace,
          description: workspace.metadata?.description,
          type: workspace.metadata?.ephemeral ? "ephemeral" : "persistent",
        });
      } catch (error) {
        return c.json({ error: `Failed to update persistence: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Update workspace metadata
  .patch(
    "/:workspaceId/metadata",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator(
      "json",
      z.object({
        name: z.string().min(1).optional(),
        color: ColorSchema.optional(),
        description: z.string().optional(),
        blueprintArtifactId: z.string().optional(),
        blueprintRevision: z.number().optional(),
        pendingRevision: z
          .object({
            artifactId: z.string(),
            revision: z.number(),
            summary: z.string(),
            triageReasoning: z.string(),
            createdAt: z.iso.datetime(),
          })
          .optional(),
      }),
    ),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { name, ...metadataUpdates } = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        if (name && workspace.metadata?.canonical === "system") {
          return c.json({ error: "Cannot rename system canonical workspace" }, 403);
        }

        const newMetadata = { ...workspace.metadata, ...metadataUpdates };
        await manager.updateWorkspaceStatus(workspaceId, workspace.status, {
          ...(name ? { name } : {}),
          metadata: newMetadata,
        });

        const updated = { ...workspace, metadata: newMetadata, ...(name ? { name } : {}) };
        return c.json(updated, 200);
      } catch (error) {
        return c.json({ error: `Failed to update metadata: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Complete workspace setup (verify all credentials are connected)
  .post(
    "/:workspaceId/setup/complete",
    zValidator("param", z.object({ workspaceId: z.string() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        const config = await manager.getWorkspaceConfig(workspace.id);
        if (!config) {
          return c.json({ error: "Failed to load workspace configuration" }, 500);
        }

        const credentials = extractCredentials(config.workspace);

        // Group by provider and check each has a credentialId
        const byProvider = new Map<string, boolean>();
        for (const cred of credentials) {
          if (!cred.provider) continue;
          const currentlyConnected = byProvider.get(cred.provider) ?? true;
          byProvider.set(cred.provider, currentlyConnected && !!cred.credentialId);
        }

        const missingProviders = [...byProvider.entries()]
          .filter(([, connected]) => !connected)
          .map(([provider]) => provider);

        if (missingProviders.length > 0) {
          return c.json({ error: "incomplete_setup", missingProviders }, 422);
        }

        // Wire slack-app credential to workspace if present (mapping table + signal app_id)
        const slackAppCred = credentials.find(
          (cred) => cred.provider === "slack-app" && cred.credentialId,
        );
        if (slackAppCred?.credentialId) {
          try {
            const wireClient = createLinkWireClient();
            const appId = await wireClient(
              slackAppCred.credentialId,
              workspaceId,
              workspace.name,
              config.workspace.workspace?.description,
            );
            await applyMutation(workspace.path, slackSignalMutation(appId));
            await enableSlackEventSubscriptions(slackAppCred.credentialId);
          } catch (wireError) {
            logger.warn("Slack wiring failed during setup completion", {
              workspaceId,
              credentialId: slackAppCred.credentialId,
              error: stringifyError(wireError),
            });
          }
        }

        // All credentials connected — clear requires_setup
        const newMetadata = { ...workspace.metadata, requires_setup: false };
        await manager.updateWorkspaceStatus(workspaceId, workspace.status, {
          metadata: newMetadata,
        });

        return c.json({ ok: true }, 200);
      } catch (error) {
        return c.json({ error: `Failed to complete setup: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Connect Slack to a workspace. If a slack-app credential is already wired,
  // reuse it without OAuth. Otherwise the client must run OAuth and pass the
  // new credential_id; calling without one is a probe that returns
  // `{ installRequired: true }`.
  .post(
    "/:workspaceId/connect-slack",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("json", z.object({ credential_id: z.string().min(1).optional() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { credential_id } = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        const config = await manager.getWorkspaceConfig(workspace.id);
        if (!config) {
          return c.json({ error: "Failed to load workspace configuration" }, 500);
        }

        const signals = config.workspace.signals ?? {};
        const existingSlack = Object.values(signals).find((s) => s.provider === "slack");
        if (existingSlack) {
          const appId =
            existingSlack.provider === "slack" ? existingSlack.config.app_id : undefined;
          return c.json({ ok: true, alreadyConnected: true, app_id: appId }, 200);
        }

        // An already-wired slack-app takes precedence over any client-supplied credential_id.
        const wired = await resolveSlackAppByWorkspace(workspaceId);

        let credentialId: string;
        let appId: string;
        if (wired) {
          credentialId = wired.credentialId;
          appId = wired.appId;
        } else if (credential_id) {
          credentialId = credential_id;
          const wireClient = createLinkWireClient();
          appId = await wireClient(
            credential_id,
            workspaceId,
            workspace.name,
            config.workspace.workspace?.description,
          );
        } else {
          return c.json({ ok: true, installRequired: true }, 200);
        }

        // Write the signal first. If this fails we must NOT enable events or
        // evict the Chat SDK on top of a half-written config — the Link
        // credential stays wired and the probe-style retry will reuse it.
        const mutationResult = await applyMutation(workspace.path, slackSignalMutation(appId));
        if (!mutationResult.ok) {
          logger.error("connect_slack_mutation_failed", {
            workspaceId,
            appId,
            credentialId,
            reusedWiredCredential: !!wired,
            error: mutationResult.error,
          });
          return mapMutationError(c, mutationResult.error, "Slack signal mutation conflicted");
        }

        await enableSlackEventSubscriptions(credentialId);
        await ctx.evictChatSdkInstance(workspaceId);

        logger.info("slack_connected_to_workspace", {
          workspaceId,
          appId,
          credentialId,
          reusedWiredCredential: !!wired,
        });
        return c.json({ ok: true, app_id: appId }, 200);
      } catch (error) {
        logger.error("connect_slack_failed", { workspaceId, credential_id, error });
        return c.json({ error: `Failed to connect Slack: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Disconnect Slack from a workspace. Removes the chat signal and disables
  // event subscriptions. The slack-app credential is GC'd only if nothing
  // else in the workspace still references it (explicit MCP/agent env vars
  // or implicit refs from bundled agents).
  .post(
    "/:workspaceId/disconnect-slack",
    zValidator("param", z.object({ workspaceId: z.string() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        const config = await manager.getWorkspaceConfig(workspace.id);
        if (!config) {
          return c.json({ error: "Failed to load workspace configuration" }, 500);
        }

        const signals = config.workspace.signals ?? {};
        const signalEntry = Object.entries(signals).find(([, s]) => s.provider === "slack");
        if (!signalEntry) {
          return c.json({ ok: true, alreadyDisconnected: true }, 200);
        }

        const [signalId] = signalEntry;
        // Bail BEFORE any external side effects if the signal write fails —
        // otherwise we'd leave the signal on disk with the Slack app deleted.
        const mutationResult = await applyMutation(workspace.path, (cfg) =>
          deleteSignal(cfg, signalId, { force: true }),
        );
        if (!mutationResult.ok) {
          logger.error("disconnect_slack_mutation_failed", {
            workspaceId,
            signalId,
            error: mutationResult.error,
          });
          return mapMutationError(c, mutationResult.error, "Slack signal mutation conflicted");
        }

        // May already be gone if Link state drifted from the workspace config.
        const wired = await resolveSlackAppByWorkspace(workspaceId);

        let deletedApp = false;
        if (wired) {
          await disableSlackEventSubscriptions(wired.credentialId);

          // injectBundledAgentRefs hydrates implicit refs from bundled agents
          // so extractCredentials sees them when checking if slack-app is still used.
          const after = await manager.getWorkspaceConfig(workspace.id);
          const configAfter = after?.workspace ?? config.workspace;
          const injected = injectBundledAgentRefs(configAfter);
          const stillUsed = extractCredentials(injected).some((u) => u.provider === "slack-app");

          if (!stillUsed) {
            await deleteSlackApp(wired.appId);
            deletedApp = true;
          } else {
            logger.info("slack_app_kept_on_disconnect", {
              workspaceId,
              appId: wired.appId,
              reason: "still_referenced_by_workspace",
            });
          }
        }

        await ctx.evictChatSdkInstance(workspaceId);

        logger.info("slack_disconnected_from_workspace", { workspaceId, signalId, deletedApp });
        return c.json({ ok: true, deletedApp }, 200);
      } catch (error) {
        logger.error("disconnect_slack_failed", { workspaceId, error });
        return c.json({ error: `Failed to disconnect Slack: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Get pending revision proposal
  .get(
    "/:workspaceId/pending-revision",
    zValidator("param", z.object({ workspaceId: z.string() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        const pending = workspace.metadata?.pendingRevision;
        if (!pending) {
          return c.json({ pendingRevision: null });
        }

        // Load the proposed artifact revision for diff context
        const artifactResult = await ArtifactStorage.get({
          id: pending.artifactId,
          revision: pending.revision,
        });

        return c.json({
          pendingRevision: pending,
          artifact: artifactResult.ok ? artifactResult.data : null,
        });
      } catch (error) {
        return c.json({ error: `Failed to load pending revision: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Approve pending revision — recompile with proposed artifact/revision
  .post(
    "/:workspaceId/pending-revision/approve",
    zValidator("param", z.object({ workspaceId: z.string() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        const pending = workspace.metadata?.pendingRevision;
        if (!pending) {
          return c.json({ error: "No pending revision to approve" }, 404);
        }

        const loaded = await loadWorkspaceBlueprint(workspace, {
          artifactId: pending.artifactId,
          revision: pending.revision,
        });
        if (!loaded.ok) {
          return c.json({ error: loaded.error }, loaded.status);
        }

        const result = await applyBlueprint(
          workspace,
          loaded.blueprint,
          loaded.artifactId,
          loaded.revision,
          ctx,
          { extraMetadata: { pendingRevision: undefined } },
        );
        if (!result.ok) {
          return c.json({ error: result.error }, result.status);
        }

        logger.info("Pending revision approved and applied", {
          workspaceId,
          artifactId: pending.artifactId,
          revision: pending.revision,
        });

        return c.json({
          ok: true,
          workspaceId,
          artifactId: pending.artifactId,
          revision: pending.revision,
        });
      } catch (error) {
        logger.error("Failed to approve pending revision", { workspaceId, error });
        return c.json({ error: `Approve failed: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Reject pending revision — clear from metadata without applying
  .post(
    "/:workspaceId/pending-revision/reject",
    zValidator("param", z.object({ workspaceId: z.string() })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        if (!workspace.metadata?.pendingRevision) {
          return c.json({ error: "No pending revision to reject" }, 404);
        }

        const newMetadata = { ...workspace.metadata, pendingRevision: undefined };
        await manager.updateWorkspaceStatus(workspaceId, workspace.status, {
          metadata: newMetadata,
        });

        logger.info("Pending revision rejected", { workspaceId });

        return c.json({ ok: true, workspaceId });
      } catch (error) {
        return c.json({ error: `Reject failed: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Recompile workspace.yml from blueprint artifact
  .post(
    "/:workspaceId/recompile",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator(
      "json",
      z.object({ artifactId: z.string().optional(), revision: z.number().optional() }),
    ),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const body = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const manager = ctx.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });
        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        // Resolve artifact ID: explicit param > workspace metadata > error
        const artifactId = body.artifactId ?? workspace.metadata?.blueprintArtifactId;
        if (!artifactId) {
          return c.json(
            {
              error:
                "No blueprint artifact ID provided and workspace has no linked blueprint. " +
                "Pass artifactId in the request body.",
            },
            400,
          );
        }

        const loaded = await loadWorkspaceBlueprint(workspace, {
          artifactId,
          revision: body.revision,
        });
        if (!loaded.ok) {
          return c.json({ error: loaded.error }, loaded.status);
        }

        const result = await applyBlueprint(
          workspace,
          loaded.blueprint,
          loaded.artifactId,
          loaded.revision,
          ctx,
        );
        if (!result.ok) {
          return c.json({ error: result.error }, result.status);
        }

        return c.json({
          ok: true,
          workspaceId,
          artifactId: loaded.artifactId,
          revision: loaded.revision,
          runtimeReloaded: result.runtimeReloaded,
        });
      } catch (error) {
        logger.error("Failed to recompile workspace", { workspaceId, error });
        return c.json({ error: `Recompile failed: ${stringifyError(error)}` }, 500);
      }
    },
  )
  // Trigger a workspace signal (SSE mode)
  // Registered as a separate middleware before the JSON handler so the SSE return
  // type doesn't widen the JSON handler's inferred type (Hono RPC client derives
  // response shape from return type — mixing stream + json breaks inference).
  .post("/:workspaceId/signals/:signalId", async (c, next) => {
    if (!c.req.header("accept")?.includes("text/event-stream")) {
      return next();
    }

    const paramResult = signalParamSchema.safeParse(c.req.param());
    if (!paramResult.success) {
      return c.json({ error: paramResult.error.message }, 400);
    }
    const { workspaceId, signalId } = paramResult.data;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const bodyResult = signalBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return c.json({ error: bodyResult.error.message }, 400);
    }
    const body = bodyResult.data;
    const ctx = c.get("app");

    // Pre-stream validation: return HTTP error before committing to SSE stream
    const manager = ctx.daemon.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
    }

    const encoder = new TextEncoder();

    const sseStream = new ReadableStream({
      start(controller) {
        ctx.daemon
          .triggerWorkspaceSignal(
            workspaceId,
            signalId,
            body.payload,
            body.streamId,
            (chunk) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch (error) {
                logger.debug("Client disconnected during signal SSE stream", {
                  workspaceId,
                  signalId,
                  error,
                });
              }
            },
            body.skipStates,
          )
          .then((result) => {
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "job-complete",
                    data: { success: true, sessionId: result.sessionId, status: "completed" },
                  })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch (enqueueError) {
              logger.debug("Client disconnected before job-complete event", {
                workspaceId,
                signalId,
                error: enqueueError,
              });
            }
          })
          .catch((error) => {
            const errorMessage = stringifyError(error);
            logger.error("Signal trigger SSE error", {
              error: errorMessage,
              workspaceId,
              signalId,
            });
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "job-error", data: { error: errorMessage } })}\n\n`,
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch (enqueueError) {
              logger.debug("Client disconnected before job-error event", {
                workspaceId,
                signalId,
                error: enqueueError,
              });
            }
          })
          .finally(() => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
      },
    });

    return new Response(sseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  })
  // Trigger a workspace signal (JSON mode)
  .post(
    "/:workspaceId/signals/:signalId",
    zValidator("param", signalParamSchema),
    zValidator("json", signalBodySchema),
    async (c) => {
      const { workspaceId, signalId } = c.req.valid("param");
      const { payload, streamId, skipStates } = c.req.valid("json");
      const ctx = c.get("app");

      try {
        const result = await ctx.daemon.triggerWorkspaceSignal(
          workspaceId,
          signalId,
          payload,
          streamId,
          undefined,
          skipStates,
        );
        return c.json({
          message: "Signal completed",
          status: "completed" as const,
          workspaceId,
          signalId,
          sessionId: result.sessionId,
        });
      } catch (error) {
        const errorMessage = stringifyError(error);
        if (error instanceof SessionFailedError) {
          logger.warn("Signal session failed", { error });
          return c.json({ error: errorMessage }, 422);
        }
        if (error instanceof UserConfigurationError) {
          logger.warn("Signal skipped due to user configuration error", { error });
          return c.json({ error: errorMessage }, 422);
        }
        if (error instanceof WorkspaceNotFoundError) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }
        if (error instanceof MissingEnvironmentError) {
          logger.warn("Workspace has missing required environment variables", {
            error,
            workspaceId,
          });
          return c.json({ error: "Workspace has missing required environment variables" }, 422);
        }
        logger.error("Failed to process signal", { error });
        if (errorMessage.includes("Workspace path does not exist")) {
          return c.json(
            {
              error: `Workspace '${workspaceId}' is not running. The workspace directory is unavailable.`,
            },
            422,
          );
        }
        if (
          errorMessage.includes("No FSM job handles signal") ||
          errorMessage.includes("Signal not found")
        ) {
          return c.json(
            { error: `Signal '${signalId}' not found in workspace '${workspaceId}'` },
            404,
          );
        }
        if (errorMessage.includes("payload validation failed")) {
          return c.json({ error: errorMessage }, 400);
        }
        if (errorMessage.includes("already has an active session")) {
          return c.json({ error: errorMessage }, 409);
        }
        return c.json({ error: `Failed to process signal: ${errorMessage}` }, 500);
      }
    },
  )
  // List jobs in a workspace
  .get("/:workspaceId/jobs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    const manager = ctx.getWorkspaceManager();
    const config = await manager.getWorkspaceConfig(workspaceId);
    if (!config) {
      return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
    }
    const workspaceConfig = config.workspace;
    const jobs = workspaceConfig?.jobs || {};

    return c.json(
      Object.entries(jobs).map(([key, job]) => ({
        id: key,
        name: formatJobName(key, job),
        description: job.description,
        integrations: extractJobIntegrations(job, workspaceConfig),
      })),
    );
  })
  // Get workspace sessions
  .get("/:workspaceId/sessions", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }

      const runtime = ctx.daemon.runtimes.get(workspace.id);
      if (!runtime) {
        return c.json([]); // No runtime = no sessions
      }

      const sessions = runtime.listSessions();
      return c.json(sessions);
    } catch (error) {
      logger.error("Failed to list workspace sessions", { error, workspaceId });
      return c.json({ error: `Failed to list workspace sessions: ${stringifyError(error)}` }, 500);
    }
  })
  // List signals in a workspace
  .get("/:workspaceId/signals", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const signals = runtime.listSignals();
      return c.json({ signals: signals.map((signal) => ({ name: signal.id, signal })) }, 200);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      if (error instanceof MissingEnvironmentError) {
        logger.warn("Workspace has missing required environment variables", { error, workspaceId });
        return c.json({ error: "Workspace has missing required environment variables" }, 422);
      }
      const errorMessage = stringifyError(error);
      // When workspace path doesn't exist (stopped/deleted workspace), fall back to config
      if (errorMessage.includes("Workspace path does not exist")) {
        logger.debug("Workspace path unavailable, reading signals from config", { workspaceId });
        const manager = ctx.getWorkspaceManager();
        const config = await manager.getWorkspaceConfig(workspaceId);
        const signals = config?.workspace?.signals || {};
        return c.json(
          {
            signals: Object.entries(signals).map(([id, signalConfig]) => ({
              name: id,
              signal: {
                id,
                description: signalConfig.description,
                provider: signalConfig.provider,
              },
            })),
          },
          200,
        );
      }
      logger.error("Failed to list signals", { error, workspaceId });
      return c.json({ error: `Failed to list signals: ${errorMessage}` }, 500);
    }
  })
  // Describe specific agent in a workspace
  .get("/:workspaceId/agents/:agentId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const agentId = c.req.param("agentId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const agent = runtime.describeAgent(agentId);
      return c.json(agent, 200);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      if (error instanceof MissingEnvironmentError) {
        logger.warn("Workspace has missing required environment variables", { error, workspaceId });
        return c.json({ error: "Workspace has missing required environment variables" }, 422);
      }
      logger.error("Failed to describe agent", { error, workspaceId, agentId });
      return c.json({ error: `Failed to describe agent: ${stringifyError(error)}` }, 500);
    }
  })
  // List agents in a workspace
  .get("/:workspaceId/agents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      const runtime = await ctx.daemon.getOrCreateWorkspaceRuntime(workspaceId);
      const agents = runtime.listAgents();
      return c.json(agents);
    } catch (error) {
      if (error instanceof WorkspaceNotFoundError) {
        return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
      }
      if (error instanceof MissingEnvironmentError) {
        logger.warn("Workspace has missing required environment variables", { error, workspaceId });
        return c.json({ error: "Workspace has missing required environment variables" }, 422);
      }
      logger.error("Failed to list agents", { error, workspaceId });
      return c.json({ error: `Failed to list agents: ${stringifyError(error)}` }, 500);
    }
  })
  // Delete a workspace
  .delete(
    "/:workspaceId",
    zValidator("param", z.object({ workspaceId: z.string() })),
    zValidator("query", z.object({ force: z.literal("true").optional() }).optional()),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const ctx = c.get("app");

      const force = c.req.valid("query")?.force === "true";

      try {
        const manager = ctx.daemon.getWorkspaceManager();
        const workspace = await manager.find({ id: workspaceId });

        if (!workspace) {
          return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
        }

        if (workspace.metadata?.canonical && !force) {
          return c.json({ error: `Cannot delete canonical workspace '${workspaceId}'` }, 403);
        }

        // Check if workspace is in .atlas directory
        const atlasDir = getAtlasHome();
        const workspacePath = workspace.path;

        if (workspacePath.startsWith(atlasDir)) {
          // Create unregistered directory if it doesn't exist
          const unregisteredDir = join(atlasDir, "unregistered");
          await mkdir(unregisteredDir, { recursive: true });

          // Move workspace to unregistered folder with collision handling
          const workspaceName = workspacePath.split("/").pop() || workspaceId;
          let targetPath = join(unregisteredDir, workspaceName);
          let counter = 1;

          // Find an available name if there's a collision
          while (true) {
            try {
              await stat(targetPath);
              // Path exists, try next number
              counter++;
              targetPath = join(unregisteredDir, `${workspaceName}-${counter}`);
            } catch (error) {
              // Path doesn't exist (NotFound error), we can use it
              if (isErrnoException(error) && error.code === "ENOENT") {
                break;
              }
              // Some other error, throw it
              throw error;
            }
          }

          try {
            await rename(workspacePath, targetPath);
            logger.info("Moved workspace to unregistered", {
              workspaceId,
              oldPath: workspacePath,
              newPath: targetPath,
            });
          } catch (error) {
            logger.warn("Failed to move workspace to unregistered", {
              error,
              workspaceId,
              workspacePath,
            });
            // Continue with deletion even if move fails
          }
        }

        await manager.deleteWorkspace(workspaceId, { force });
        return c.json({ message: `Workspace ${workspaceId} deleted` });
      } catch (error) {
        logger.error("Failed to delete workspace", { error, workspaceId });
        return c.json({ error: `Failed to delete workspace: ${stringifyError(error)}` }, 500);
      }
    },
  )
  .route("/:workspaceId/resources", resourceRoutes)
  // ─── WORKSPACE SKILLS (resolved) ──────────────────────────────────────────
  .get(
    "/:workspaceId/skills",
    zValidator("param", z.object({ workspaceId: z.string().min(1) })),
    async (c) => {
      const { workspaceId } = c.req.valid("param");
      const skills = await resolveVisibleSkills(workspaceId, SkillStorage);
      return c.json({ skills });
    },
  );

export { workspacesRoutes };
export type WorkspaceRoutes = typeof workspacesRoutes;
