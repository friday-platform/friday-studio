/**
 * Commit handler for `workspace-setup` elicitation answers.
 *
 * The submit composes two distinct atomic mutations: env writes via
 * `setEnvFileVar`, credential pins via `updateCredential` on the parsed
 * workspace config. There is no shared transaction across both — Decision 6.
 *
 * Pre-flight runs first: every variable value is validated against its
 * declared schema, every chosen credential id is confirmed to exist in Link.
 * On any error the handler returns 400 with a per-field error map and writes
 * nothing. Once pre-flight passes, env writes commit first, then the
 * credential mutation batch. A failure in the credential batch leaves the
 * elicitation pending and surfaces the env keys that already committed — the
 * retry is idempotent because re-writing a value that is already correct is a
 * no-op.
 *
 * After commit the caller is responsible for running
 * `handleWorkspaceConfigChange` so the setup gate re-evaluates and any
 * deferred schedule / fs-watch registrations land.
 */

import { join } from "node:path";
import { encodeForEnv, type WorkspaceConfig } from "@atlas/config";
import { extractCredentials, type MutationResult, updateCredential } from "@atlas/config/mutations";
import type { WorkspaceSetupAnswerValue } from "@atlas/core/elicitations";
import {
  fetchLinkCredential,
  LinkCredentialNotFoundError,
} from "@atlas/core/mcp-registry/credential-resolver";
import { createLogger, type Logger } from "@atlas/logger";
import { setEnvFileVar, variableEnvKey } from "@atlas/workspace";
import { z } from "zod";
import { applyDraftAwareMutation } from "../routes/workspaces/draft-helpers.ts";

export type SetupAnswerResult =
  | { ok: true; committedKeys: string[] }
  | {
      ok: false;
      status: 400;
      errors: { variables: Record<string, string>; credentials: Record<string, string> };
    }
  | { ok: false; status: 500; message: string; committedKeys: string[] };

export interface SetupAnswerInputs {
  workspacePath: string;
  parsedConfig: WorkspaceConfig;
  answer: WorkspaceSetupAnswerValue;
}

const logger = createLogger({ component: "setup-answer-handler" });

/**
 * Validate, then commit a `workspace-setup` elicitation answer. Returns a
 * discriminated result the route handler maps onto HTTP status codes.
 */
export async function commitWorkspaceSetupAnswer(
  inputs: SetupAnswerInputs,
): Promise<SetupAnswerResult> {
  const { workspacePath, parsedConfig, answer } = inputs;

  const preflight = await preflightWorkspaceSetupAnswer(parsedConfig, answer, logger);
  if (!preflight.ok) {
    return { ok: false, status: 400, errors: preflight.errors };
  }

  const envPath = join(workspacePath, ".env");
  const committedKeys: string[] = [];
  for (const { name, raw } of preflight.envWrites) {
    try {
      setEnvFileVar(envPath, variableEnvKey(name), raw);
      committedKeys.push(variableEnvKey(name));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("workspace-setup env write failed", { workspacePath, name, error: message });
      return { ok: false, status: 500, message: `env write failed: ${message}`, committedKeys };
    }
  }

  if (preflight.credentialPlan.length > 0) {
    const credentialPlan = preflight.credentialPlan;
    const mutationFn = (cfg: WorkspaceConfig): MutationResult<WorkspaceConfig> => {
      let next = cfg;
      for (const pin of credentialPlan) {
        const stepped = updateCredential(next, pin.path, pin.credentialId, pin.provider);
        if (!stepped.ok) return stepped;
        next = stepped.value;
      }
      return { ok: true, value: next };
    };
    try {
      const { result } = await applyDraftAwareMutation(workspacePath, mutationFn);
      if (!result.ok) {
        const message = `credential pin failed: ${result.error.type}${
          "message" in result.error && result.error.message ? `: ${result.error.message}` : ""
        }`;
        logger.error("workspace-setup credential pin failed", { workspacePath, error: message });
        return { ok: false, status: 500, message, committedKeys };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("workspace-setup credential pin threw", { workspacePath, error: message });
      return {
        ok: false,
        status: 500,
        message: `credential pin failed: ${message}`,
        committedKeys,
      };
    }
  }

  return { ok: true, committedKeys };
}

interface PreflightOk {
  ok: true;
  envWrites: Array<{ name: string; raw: string }>;
  credentialPlan: Array<{ path: string; provider: string; credentialId: string }>;
}

interface PreflightErr {
  ok: false;
  errors: { variables: Record<string, string>; credentials: Record<string, string> };
}

async function preflightWorkspaceSetupAnswer(
  parsedConfig: WorkspaceConfig,
  answer: WorkspaceSetupAnswerValue,
  log: Logger,
): Promise<PreflightOk | PreflightErr> {
  const variableErrors: Record<string, string> = {};
  const credentialErrors: Record<string, string> = {};
  const envWrites: Array<{ name: string; raw: string }> = [];

  const declarations = parsedConfig.variables ?? {};
  for (const [name, value] of Object.entries(answer.variableValues)) {
    const decl = declarations[name];
    if (!decl) {
      variableErrors[name] = `Variable '${name}' is not declared on this workspace`;
      continue;
    }
    const schema = z.fromJSONSchema(decl.schema);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      variableErrors[name] = parsed.error.issues.map((i) => i.message).join("; ");
      continue;
    }
    envWrites.push({ name, raw: encodeForEnv(parsed.data, decl) });
  }

  const usagesByProvider = new Map<string, string[]>();
  for (const usage of extractCredentials(parsedConfig)) {
    if (!usage.provider) continue;
    const paths = usagesByProvider.get(usage.provider);
    if (paths) paths.push(usage.path);
    else usagesByProvider.set(usage.provider, [usage.path]);
  }

  const credentialPlan: Array<{ path: string; provider: string; credentialId: string }> = [];
  for (const [provider, credentialId] of Object.entries(answer.credentialChoices)) {
    const paths = usagesByProvider.get(provider);
    if (!paths || paths.length === 0) {
      credentialErrors[provider] = `Provider '${provider}' is not referenced by this workspace`;
      continue;
    }
    try {
      const fetched = await fetchLinkCredential(credentialId, log);
      if (fetched.provider !== provider) {
        credentialErrors[provider] =
          `Credential '${credentialId}' belongs to provider '${fetched.provider}', not '${provider}'`;
        continue;
      }
      for (const path of paths) {
        credentialPlan.push({ path, provider, credentialId });
      }
    } catch (err) {
      if (err instanceof LinkCredentialNotFoundError) {
        credentialErrors[provider] = `Credential '${credentialId}' was not found in Link`;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      credentialErrors[provider] = `Credential lookup failed: ${message}`;
    }
  }

  if (Object.keys(variableErrors).length > 0 || Object.keys(credentialErrors).length > 0) {
    return { ok: false, errors: { variables: variableErrors, credentials: credentialErrors } };
  }

  return { ok: true, envWrites, credentialPlan };
}
