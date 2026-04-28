import {
  SignalConfigPatchSchema,
  type WorkspaceConfig,
  type WorkspaceSignalConfig,
  WorkspaceSignalConfigSchema,
} from "@atlas/config";
import {
  applyMutation,
  type CredentialUsage,
  createSignal,
  deleteSignal,
  extractCredentials,
  extractFSMAgents,
  type FSMAgentResponse,
  FSMAgentUpdateSchema,
  type MutationResult,
  parseCredentialPath,
  patchBlueprintSignalConfig,
  patchSignalConfig,
  updateBlueprintCredential,
  updateBlueprintFSMAgent,
  updateBlueprintSignalConfig,
  updateCredential,
  updateFSMAgent,
  updateSignal,
} from "@atlas/config/mutations";
import {
  type Credential,
  fetchLinkCredential,
  LinkCredentialNotFoundError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger } from "@atlas/logger";
import { storeWorkspaceHistory } from "@atlas/storage";
import { stringifyError } from "@atlas/utils";
import type { WorkspaceBlueprint } from "@atlas/workspace-builder";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type AppVariables, daemonFactory } from "../../src/factory.ts";
import {
  loadWorkspaceBlueprint,
  saveAndRecompileBlueprint,
  withBlueprintMutation,
} from "./blueprint-recompile.ts";
import { injectBundledAgentRefs } from "./index.ts";
import { applyDraftAwareMutation, getEditableConfig } from "./draft-helpers.ts";
import { mapMutationError } from "./mutation-errors.ts";

/**
 * Extract a required route parameter from the Hono context.
 * Throws HTTPException 400 if the parameter is missing.
 *
 * @param c - Hono context
 * @param name - Parameter name to extract
 * @returns The parameter value (guaranteed non-undefined)
 * @throws HTTPException with status 400 if parameter is missing
 */
function requireParam(c: Context<AppVariables>, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new HTTPException(400, { message: `Missing required parameter: ${name}` });
  }
  return value;
}

/**
 * Workspace config mutation routes.
 *
 * Provides HTTP endpoints for partial updates to workspace configuration
 * including signals and agents. These routes operate on the raw
 * config (workspace.yml), not runtime state.
 *
 */

/**
 * Schema for creating a new signal.
 * Requires signalId plus the full signal configuration.
 */
const CreateSignalInputSchema = z.object({
  signalId: z.string().min(1, "Signal ID is required"),
  signal: WorkspaceSignalConfigSchema,
});

/**
 * Signal response format for API.
 * Returns raw WorkspaceSignalConfig with id added.
 *
 * Why raw config instead of transformed:
 * - GET and PUT use the same shape (no client-side transformation needed)
 * - All fields (description, title, schema) are useful for UI display
 * - Consistent with POST which also accepts WorkspaceSignalConfig
 */
type SignalResponse = WorkspaceSignalConfig & { id: string };

// ==============================================================================
// GET HANDLER FACTORY
// ==============================================================================

/**
 * Configuration for GET handlers that list or fetch entities from workspace config.
 *
 * Why a factory instead of inline handlers:
 * - 6 GET handlers (3 list + 3 single) share identical workspace lookup, config loading,
 *   and error response logic. Inlining would duplicate ~20 lines per handler.
 * - Consistency guarantee: all GET endpoints return identical error shapes (404 for
 *   missing workspace/entity, 500 for config loading failures). A factory ensures
 *   this can't drift between handlers.
 * - Change amplification: if error response shape changes, update one place vs six.
 * - The abstraction earns itself - it's not speculative (already serves 6 handlers)
 *   and the config objects clearly show what varies (extractEntities, toResponse).
 */
interface GetHandlerConfig<TEntity, TResponse> {
  /** Entity name for errors (singular: "signal", plural: "signals") */
  entityName: string;
  /** Extract entity map from workspace config */
  extractEntities: (config: WorkspaceConfig) => Record<string, TEntity> | undefined;
  /** Transform config entity to API response */
  toResponse: (id: string, entity: TEntity) => TResponse;
  /** Response key for list responses (e.g., "signals") */
  responseKey: string;
}

/**
 * Create a list GET handler. Returns all entities with total count.
 * Handles workspace lookup (404) and config loading (500).
 */
function createGetListHandler<TEntity, TResponse>(cfg: GetHandlerConfig<TEntity, TResponse>) {
  return async (c: Context<AppVariables>) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");
    try {
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json(
          { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
          404,
        );
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json(
          { success: false, error: "internal", message: "Failed to load workspace configuration" },
          500,
        );
      }
      const entities = cfg.extractEntities(config.workspace) ?? {};
      const list = Object.entries(entities).map(([id, e]) => cfg.toResponse(id, e));
      return c.json({ [cfg.responseKey]: list, total: list.length });
    } catch (error) {
      return c.json(
        {
          success: false,
          error: "internal",
          message: `Failed to list ${cfg.entityName}: ${stringifyError(error)}`,
        },
        500,
      );
    }
  };
}

/**
 * Create a single GET handler. Returns one entity by ID.
 * Handles workspace lookup (404), config loading (500), and entity lookup (404).
 */
function createGetSingleHandler<TEntity, TResponse>(
  cfg: GetHandlerConfig<TEntity, TResponse> & {
    extractEntityId: (c: Context<AppVariables>) => string;
  },
) {
  return async (c: Context<AppVariables>) => {
    const workspaceId = c.req.param("workspaceId");
    const entityId = cfg.extractEntityId(c);
    const ctx = c.get("app");
    try {
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json(
          { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
          404,
        );
      }
      const config = await manager.getWorkspaceConfig(workspace.id);
      if (!config) {
        return c.json(
          { success: false, error: "internal", message: "Failed to load workspace configuration" },
          500,
        );
      }
      const entities = cfg.extractEntities(config.workspace) ?? {};
      const entity = entities[entityId];
      if (!entity) {
        // entityName is plural, remove trailing 's' for singular entity type
        const entityType = cfg.entityName.endsWith("s")
          ? cfg.entityName.slice(0, -1)
          : cfg.entityName;
        return c.json({ success: false, error: "not_found", entityType, entityId }, 404);
      }
      return c.json(cfg.toResponse(entityId, entity));
    } catch (error) {
      const entityType = cfg.entityName.endsWith("s")
        ? cfg.entityName.slice(0, -1)
        : cfg.entityName;
      return c.json(
        {
          success: false,
          error: "internal",
          message: `Failed to get ${entityType}: ${stringifyError(error)}`,
        },
        500,
      );
    }
  };
}

// GET handler configs for each entity type
const signalGetConfig: GetHandlerConfig<WorkspaceSignalConfig, SignalResponse> = {
  entityName: "signals",
  extractEntities: (c) => c.signals,
  toResponse: (id, signal) => ({ id, ...signal }),
  responseKey: "signals",
};

const agentGetConfig: GetHandlerConfig<FSMAgentResponse, FSMAgentResponse> = {
  entityName: "agents",
  extractEntities: extractFSMAgents,
  toResponse: (_, agent) => agent,
  responseKey: "agents",
};

// GET handler instances
const handleListSignals = createGetListHandler(signalGetConfig);
const handleGetSignal = createGetSingleHandler({
  ...signalGetConfig,
  extractEntityId: (c) => requireParam(c, "signalId"),
});
const handleListAgents = createGetListHandler(agentGetConfig);
const handleGetAgent = createGetSingleHandler({
  ...agentGetConfig,
  extractEntityId: (c) => requireParam(c, "agentId"),
});

/**
 * GET /credentials - List all credential references in workspace config.
 * Returns flat list of CredentialUsage objects (no single-item GET needed).
 */
async function handleListCredentials(c: Context<AppVariables>) {
  const workspaceId = c.req.param("workspaceId");
  const ctx = c.get("app");
  try {
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json(
        { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
        404,
      );
    }
    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }
    const configWithAgentRefs = injectBundledAgentRefs(config.workspace);
    const credentials: CredentialUsage[] = extractCredentials(configWithAgentRefs);
    return c.json({ credentials, total: credentials.length });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: "internal",
        message: `Failed to list credentials: ${stringifyError(error)}`,
      },
      500,
    );
  }
}

const credentialLogger = createLogger({ component: "config-credentials" });

/**
 * Schema for credential update request body.
 */
const UpdateCredentialInputSchema = z.object({
  credentialId: z.string().min(1, "credentialId is required"),
});

/**
 * PUT /credentials/:path - Update a credential reference with Link validation.
 *
 * Blueprint-aware: when the workspace has a linked blueprint, updates the
 * credential binding in the blueprint and recompiles. Falls back to direct
 * workspace.yml mutation for non-blueprint workspaces.
 *
 * Custom handler (not using createMutationHandler) because:
 * 1. Needs async Link validation before mutation
 * 2. Provider lookup logic depends on current credential state
 * 3. Different error response format (credential_not_found, provider_mismatch)
 */
async function handleUpdateCredential(
  c: Context<AppVariables>,
  body: z.infer<typeof UpdateCredentialInputSchema>,
) {
  const workspaceId = c.req.param("workspaceId");
  const path = c.req.param("path");
  if (!path) {
    return c.json(
      { success: false, error: "bad_request", message: "Missing credential path" },
      400,
    );
  }
  const ctx = c.get("app");
  const { credentialId: newCredentialId } = body;

  try {
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json(
        { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
        404,
      );
    }

    if (workspace.metadata?.canonical === "system") {
      return c.json(
        { success: false, error: "forbidden", message: "Cannot modify system canonical workspace" },
        403,
      );
    }
    if (workspace.metadata?.system && workspace.metadata?.canonical !== "personal") {
      return c.json(
        { success: false, error: "forbidden", message: "Cannot modify system workspace" },
        403,
      );
    }

    const config = await manager.getWorkspaceConfig(workspace.id);
    if (!config) {
      return c.json(
        { success: false, error: "internal", message: "Failed to load workspace configuration" },
        500,
      );
    }

    // Load editable config (draft if exists, live otherwise) for credential lookup
    const editableResult = await getEditableConfig(workspace.path);
    if (!editableResult.ok) {
      return c.json(
        { success: false, error: "internal", message: editableResult.error },
        500,
      );
    }

    const credentials = extractCredentials(editableResult.value);
    const current = credentials.find((cred) => cred.path === path);
    if (!current) {
      return c.json(
        { success: false, error: "not_found", entityType: "credential", entityId: path },
        404,
      );
    }

    // Validate new credential exists in Link
    let newCredential: Credential;
    try {
      newCredential = await fetchLinkCredential(newCredentialId, credentialLogger);
    } catch (error) {
      if (error instanceof LinkCredentialNotFoundError) {
        return c.json({ error: "credential_not_found", credentialId: newCredentialId }, 400);
      }
      throw error;
    }

    // Determine expected provider: use current.provider if present, else fetch from Link
    let expectedProvider: string | undefined;
    if (current.provider) {
      expectedProvider = current.provider;
    } else if (current.credentialId) {
      try {
        const currentCredential = await fetchLinkCredential(current.credentialId, credentialLogger);
        expectedProvider = currentCredential.provider;
      } catch (error) {
        if (error instanceof LinkCredentialNotFoundError) {
          // Old credential deleted — skip provider validation
          expectedProvider = undefined;
        } else {
          throw error;
        }
      }
    }

    if (expectedProvider && newCredential.provider !== expectedProvider) {
      return c.json(
        { error: "provider_mismatch", expected: expectedProvider, got: newCredential.provider },
        400,
      );
    }

    // Blueprint path — when a blueprint exists, all mutations go through it.
    // Failures are surfaced, never silently falling back to direct workspace.yml mutation.
    if (workspace.metadata?.blueprintArtifactId) {
      const parsed = parseCredentialPath(path);
      if (!parsed) {
        return c.json(
          {
            success: false,
            error: "bad_request",
            message: `Cannot parse credential path: ${path}`,
          },
          400,
        );
      }

      const loaded = await loadWorkspaceBlueprint(workspace);
      if (!loaded.ok) {
        return c.json({ success: false, error: "internal", message: loaded.error }, loaded.status);
      }

      const mutationResult = updateBlueprintCredential(
        loaded.blueprint,
        parsed.type,
        parsed.entityId,
        parsed.envVar,
        newCredentialId,
        newCredential.provider,
      );
      if (!mutationResult.ok) {
        return c.json(
          {
            success: false,
            error: "not_found",
            message: `Credential binding not found in blueprint: ${path}`,
          },
          404,
        );
      }

      const recompileResult = await saveAndRecompileBlueprint(
        workspace,
        mutationResult.value,
        loaded.artifactId,
        ctx,
        `Update credential: ${path}`,
      );
      if (!recompileResult.ok) {
        return c.json(
          { success: false, error: "internal", message: recompileResult.error },
          recompileResult.status,
        );
      }

      return c.json({ ok: true });
    }

    // No blueprint — draft-aware mutation (goes to draft if one exists)
    const mutationFn = (cfg: WorkspaceConfig) =>
      updateCredential(cfg, path, newCredentialId, newCredential.provider);
    const { result, wroteToDraft } = await applyDraftAwareMutation(workspace.path, mutationFn, {
      onBeforeWrite: async () => {
        await storeWorkspaceHistory(workspace, config.workspace, "partial-update", {
          throwOnError: true,
        });
      },
    });

    if (!result.ok) {
      const error = result.error;
      if (error.type === "not_found") {
        return c.json(
          {
            success: false,
            error: "not_found",
            entityType: error.entityType,
            entityId: error.entityId,
          },
          404,
        );
      }
      if (error.type === "validation") {
        return c.json(
          { success: false, error: "validation", message: error.message, issues: error.issues },
          400,
        );
      }
      return c.json(
        { success: false, error: "internal", message: `Mutation failed: ${error.type}` },
        500,
      );
    }

    // Destroy runtime only when writing directly to live config.
    // Draft writes defer reload until publish triggers it.
    if (!wroteToDraft) {
      const runtime = ctx.getWorkspaceRuntime(workspace.id);
      if (runtime) {
        await ctx.destroyWorkspaceRuntime(workspace.id);
      }
    }

    return c.json({ ok: true });
  } catch (error) {
    return c.json(
      { success: false, error: "internal", message: `Mutation failed: ${stringifyError(error)}` },
      500,
    );
  }
}

// ==============================================================================
// MUTATION HANDLER HELPER
// ==============================================================================

/**
 * Base configuration shared by both with-schema and without-schema mutation handlers.
 *
 * @template TParams - Type of extracted route params
 */
interface MutationHandlerConfigBase<TParams> {
  /** Extract route params (e.g., signalId, serverId) from Hono context */
  extractParams: (c: Context<AppVariables>) => TParams;
  /** HTTP status code for successful response (200 for PUT/DELETE, 201 for POST) */
  successStatus: 200 | 201;
  /** Entity name for conflict messages (e.g., "Signal", "Tool") */
  entityName: string;
}

/**
 * Configuration for mutation handlers that require request body validation.
 *
 * @template TSchema - Zod schema type for input validation
 * @template TParams - Type of extracted route params
 */
interface MutationHandlerConfigWithSchema<TSchema extends z.ZodType, TParams>
  extends MutationHandlerConfigBase<TParams> {
  /** Zod schema to parse and validate request body */
  schema: TSchema;
  /** Build the mutation function from parsed input and params */
  buildMutation: (
    input: z.infer<TSchema>,
    params: TParams,
  ) => (config: WorkspaceConfig) => MutationResult<WorkspaceConfig>;
  /**
   * Custom conflict message builder. If not provided, uses default "referenced by" message.
   * Called with the parsed input and params when a conflict occurs.
   */
  conflictMessage?: (input: z.infer<TSchema>, params: TParams, referenceCount: number) => string;
}

/**
 * Configuration for mutation handlers that don't need request body (e.g., DELETE).
 *
 * @template TParams - Type of extracted route params
 */
interface MutationHandlerConfigWithoutSchema<TParams> extends MutationHandlerConfigBase<TParams> {
  /** Explicitly undefined to indicate no body parsing */
  schema: undefined;
  /** Build the mutation function from params only (input is always undefined) */
  buildMutation: (
    input: undefined,
    params: TParams,
  ) => (config: WorkspaceConfig) => MutationResult<WorkspaceConfig>;
  /**
   * Custom conflict message builder. If not provided, uses default "referenced by" message.
   * Called with undefined input and params when a conflict occurs.
   */
  conflictMessage?: (input: undefined, params: TParams, referenceCount: number) => string;
}

/**
 * Create a mutation handler with shared boilerplate.
 *
 * Handles the common pattern:
 * 1. Get workspace from manager (404 if not found)
 * 2. Check system workspace (403 if true)
 * 3. Apply mutation with onBeforeWrite callback for history storage
 * 4. Destroy runtime if active
 * 5. Return success response with configurable status code
 *
 * Body validation is handled by zValidator middleware which runs before
 * the handler. Validated input is passed as a parameter.
 *
 * @param handlerConfig - Configuration for this mutation handler
 * @returns Hono handler function
 */
function createMutationHandler<TSchema extends z.ZodType, TParams>(
  handlerConfig: MutationHandlerConfigWithSchema<TSchema, TParams>,
): (c: Context<AppVariables>, input: z.infer<TSchema>) => Promise<Response>;
function createMutationHandler<TParams>(
  handlerConfig: MutationHandlerConfigWithoutSchema<TParams>,
): (c: Context<AppVariables>) => Promise<Response>;
function createMutationHandler<TSchema extends z.ZodType, TParams>(
  handlerConfig:
    | MutationHandlerConfigWithSchema<TSchema, TParams>
    | MutationHandlerConfigWithoutSchema<TParams>,
) {
  return async (c: Context<AppVariables>, input?: z.infer<TSchema>) => {
    const workspaceId = c.req.param("workspaceId");
    const ctx = c.get("app");

    try {
      // 1. Workspace lookup
      const manager = ctx.getWorkspaceManager();
      const workspace = await manager.find({ id: workspaceId });
      if (!workspace) {
        return c.json(
          { success: false, error: "not_found", entityType: "workspace", entityId: workspaceId },
          404,
        );
      }

      // 2. System workspace / canonical protection
      if (workspace.metadata?.canonical === "system") {
        return c.json(
          {
            success: false,
            error: "forbidden",
            message: "Cannot modify system canonical workspace",
          },
          403,
        );
      }
      if (workspace.metadata?.system && workspace.metadata?.canonical !== "personal") {
        return c.json(
          { success: false, error: "forbidden", message: "Cannot modify system workspace" },
          403,
        );
      }

      // Block direct mutations on blueprint workspaces — the blueprint is the
      // source of truth and direct workspace.yml changes get overwritten on recompile.
      if (workspace.metadata?.blueprintArtifactId) {
        return c.json(
          {
            success: false,
            error: "not_supported",
            message:
              "This workspace uses a blueprint — direct config mutations are not supported. " +
              "Use the blueprint mutation path instead.",
          },
          422,
        );
      }

      // Extract route params
      const params = handlerConfig.extractParams(c);

      // Load current config for history (before mutation modifies disk)
      const currentConfig = await manager.getWorkspaceConfig(workspace.id);

      // 3. Apply mutation with onBeforeWrite callback for history storage
      // Note: The cast is safe — with-schema input comes from zValidator,
      // without-schema input is undefined (DELETE handlers).
      const mutationFn = (
        handlerConfig.buildMutation as (
          input: z.infer<TSchema> | undefined,
          params: TParams,
        ) => (config: WorkspaceConfig) => MutationResult<WorkspaceConfig>
      )(input, params);
      const result = await applyMutation(workspace.path, mutationFn, {
        onBeforeWrite: async () => {
          if (currentConfig) {
            await storeWorkspaceHistory(workspace, currentConfig.workspace, "partial-update", {
              throwOnError: true,
            });
          }
        },
      });

      if (!result.ok) {
        // Build conflict message - use custom builder or default
        const referenceCount =
          result.error.type === "conflict" ? result.error.willUnlinkFrom.length : 0;
        const conflictMessage = handlerConfig.conflictMessage
          ? (
              handlerConfig.conflictMessage as (
                input: z.infer<TSchema> | undefined,
                params: TParams,
                referenceCount: number,
              ) => string
            )(input, params, referenceCount)
          : `${handlerConfig.entityName} is referenced by ${referenceCount} ${referenceCount === 1 ? "entity" : "entities"}. Use ?force=true to cascade delete.`;
        return mapMutationError(c, result.error, conflictMessage);
      }

      // Destroy runtime if active so it reloads config on next request.
      if (ctx.getWorkspaceRuntime(workspace.id)) {
        await ctx.destroyWorkspaceRuntime(workspace.id);
      }

      // Return success
      return c.json({ ok: true }, handlerConfig.successStatus);
    } catch (error) {
      return c.json(
        { success: false, error: "internal", message: `Mutation failed: ${stringifyError(error)}` },
        500,
      );
    }
  };
}

// ==============================================================================
// METHOD NOT ALLOWED HANDLERS
// ==============================================================================

/**
 * Handler for unsupported agent creation.
 * Agents are defined in workspace FSM states and cannot be created via API.
 */
const handleAgentMethodNotAllowed = (c: Context) => {
  return c.json(
    {
      success: false,
      error: "method_not_allowed",
      message: "Agents cannot be created via API - they are defined in workspace FSM states",
    },
    405,
  );
};

/**
 * Handler for unsupported agent deletion.
 * Agents are wired into FSM states and cannot be deleted via API.
 */
const handleAgentDeleteMethodNotAllowed = (c: Context) => {
  return c.json(
    {
      success: false,
      error: "method_not_allowed",
      message: "Agents cannot be deleted via API - they are wired into workspace FSM states",
    },
    405,
  );
};

// ==============================================================================
// MUTATION HANDLER DEFINITIONS
// ==============================================================================

/** PUT /signals/:signalId - Update existing signal (legacy direct mutation) */
const handleUpdateSignalLegacy = createMutationHandler({
  schema: WorkspaceSignalConfigSchema,
  extractParams: (c) => ({ signalId: requireParam(c, "signalId") }),
  buildMutation:
    (signal, { signalId }) =>
    (config) =>
      updateSignal(config, signalId, signal),
  successStatus: 200,
  entityName: "Signal",
});

/**
 * PUT /signals/:signalId - Blueprint-aware signal update.
 *
 * When the workspace has a linked blueprint, updates the blueprint signal's
 * signalConfig, saves the new revision, and recompiles workspace.yml.
 * Falls back to direct workspace.yml mutation for non-blueprint workspaces.
 */
async function handleUpdateSignal(
  c: Context<AppVariables>,
  input: z.infer<typeof WorkspaceSignalConfigSchema>,
) {
  const signalId = requireParam(c, "signalId");

  // Map workspace signal config to blueprint signal config.
  // Only schedule and http providers have config — system/fs-watch don't exist in blueprints.
  let blueprintSignalConfig: WorkspaceBlueprint["signals"][number]["signalConfig"];
  if (input.provider === "schedule") {
    blueprintSignalConfig = { provider: "schedule", config: input.config };
  } else if (input.provider === "http") {
    blueprintSignalConfig = { provider: "http", config: input.config };
  } else {
    blueprintSignalConfig = undefined;
  }

  const result = await withBlueprintMutation(c, {
    revisionMessage: `Update signal: ${signalId}`,
    mutate: (blueprint) => updateBlueprintSignalConfig(blueprint, signalId, blueprintSignalConfig),
  });

  if (result.mode === "blueprint") return result.response;
  return handleUpdateSignalLegacy(c, input);
}

/** PATCH /signals/:signalId - Patch signal config, legacy (schedule, timezone, etc.) */
const handlePatchSignalLegacy = createMutationHandler({
  schema: SignalConfigPatchSchema,
  extractParams: (c) => ({ signalId: requireParam(c, "signalId") }),
  buildMutation:
    (configPatch, { signalId }) =>
    (config) =>
      patchSignalConfig(config, signalId, configPatch),
  successStatus: 200,
  entityName: "Signal",
});

/**
 * PATCH /signals/:signalId - Blueprint-aware signal config patch.
 *
 * When the workspace has a linked blueprint, patches the blueprint signal's
 * config sub-object, saves the new revision, and recompiles workspace.yml.
 * Falls back to direct workspace.yml mutation for non-blueprint workspaces.
 */
async function handlePatchSignal(
  c: Context<AppVariables>,
  input: z.infer<typeof SignalConfigPatchSchema>,
) {
  const signalId = requireParam(c, "signalId");

  const result = await withBlueprintMutation(c, {
    revisionMessage: `Patch signal config: ${signalId}`,
    mutate: (blueprint) =>
      patchBlueprintSignalConfig(blueprint, signalId, input as Record<string, unknown>),
  });

  if (result.mode === "blueprint") return result.response;
  return handlePatchSignalLegacy(c, input);
}

/** DELETE /signals/:signalId - Delete signal */
const handleDeleteSignal = createMutationHandler({
  schema: undefined,
  extractParams: (c) => ({
    signalId: requireParam(c, "signalId"),
    force: c.req.query("force") === "true",
  }),
  buildMutation:
    (_, { signalId, force }) =>
    (config) =>
      deleteSignal(config, signalId, { force }),
  successStatus: 200,
  entityName: "Signal",
  conflictMessage: (_, __, count) =>
    `Signal is referenced by ${count} ${count === 1 ? "job" : "jobs"}. Use ?force=true to cascade delete.`,
});

/** POST /signals - Create new signal */
const handleCreateSignal = createMutationHandler({
  schema: CreateSignalInputSchema,
  extractParams: () => ({}),
  buildMutation:
    ({ signalId, signal }) =>
    (config) =>
      createSignal(config, signalId, signal),
  successStatus: 201,
  entityName: "Signal",
  conflictMessage: ({ signalId }) => `Signal '${signalId}' already exists`,
});

/** PUT /agents/:agentId - Update existing FSM-embedded agent */
const handleUpdateAgentLegacy = createMutationHandler({
  schema: FSMAgentUpdateSchema,
  extractParams: (c) => ({ agentId: requireParam(c, "agentId") }),
  buildMutation:
    (update, { agentId }) =>
    (config) =>
      updateFSMAgent(config, agentId, update),
  successStatus: 200,
  entityName: "Agent",
});

/**
 * PUT /agents/:agentId - Blueprint-aware agent update.
 *
 * When the workspace has a linked blueprint, routes prompt updates through the
 * blueprint path (updating the DAG step description, which the compiler uses as
 * the FSM action prompt). Other fields (e.g. model) are not represented in the
 * blueprint schema — updateBlueprintFSMAgent returns not_supported for those,
 * which surfaces as a 422.
 *
 * Falls back to direct workspace.yml mutation for non-blueprint workspaces.
 */
async function handleUpdateAgent(
  c: Context<AppVariables>,
  input: z.infer<typeof FSMAgentUpdateSchema>,
) {
  const agentId = requireParam(c, "agentId");

  const result = await withBlueprintMutation(c, {
    revisionMessage: `Update agent prompt: ${agentId}`,
    mutate: (blueprint) => updateBlueprintFSMAgent(blueprint, agentId, input),
  });

  if (result.mode === "blueprint") return result.response;
  return handleUpdateAgentLegacy(c, input);
}

// ==============================================================================
// ROUTE DEFINITIONS
// ==============================================================================

/**
 * Config routes for workspace partial updates.
 *
 * Mounted at `/api/workspaces/:workspaceId/config`
 */
const configRoutes = daemonFactory
  .createApp()
  // Signals - read + full CRUD
  .get("/signals", handleListSignals)
  .get("/signals/:signalId", handleGetSignal)
  .put("/signals/:signalId", zValidator("json", WorkspaceSignalConfigSchema), (c) =>
    handleUpdateSignal(c, c.req.valid("json")),
  )
  .patch("/signals/:signalId", zValidator("json", SignalConfigPatchSchema), (c) =>
    handlePatchSignal(c, c.req.valid("json")),
  )
  .delete("/signals/:signalId", handleDeleteSignal)
  .post("/signals", zValidator("json", CreateSignalInputSchema), (c) =>
    handleCreateSignal(c, c.req.valid("json")),
  )
  // Agents - read + UPDATE ONLY (no create/delete - wired into FSM states)
  .get("/agents", handleListAgents)
  .get("/agents/:agentId", handleGetAgent)
  .put("/agents/:agentId", zValidator("json", FSMAgentUpdateSchema), (c) =>
    handleUpdateAgent(c, c.req.valid("json")),
  )
  .post("/agents", handleAgentMethodNotAllowed)
  .delete("/agents/:agentId", handleAgentDeleteMethodNotAllowed)
  // Credentials - read + update (with Link validation)
  .get("/credentials", handleListCredentials)
  .put("/credentials/:path", zValidator("json", UpdateCredentialInputSchema), (c) =>
    handleUpdateCredential(c, c.req.valid("json")),
  );

export { configRoutes };
export type WorkspaceConfigRoutes = typeof configRoutes;
