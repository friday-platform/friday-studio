import { readFileSync } from "node:fs";
import { env } from "node:process";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { createAppAuth } from "@octokit/auth-app";
import { createOAuthAppAuth } from "@octokit/auth-oauth-app";
import { request } from "@octokit/request";
import { AppInstallError } from "../app-install/errors.ts";
import { GitHubAppError } from "../github/errors.ts";
import { GitHubUserInstallationsResponseSchema } from "../github/types.ts";
import { type AppInstallProvider, defineAppInstallProvider } from "./types.ts";

async function listUserInstallations(userToken: string) {
  const response = await request("GET /user/installations", {
    headers: { authorization: `token ${userToken}` },
  }).catch((error) => {
    throw new GitHubAppError(
      "INSTALLATIONS_LIST_FAILED",
      `Failed to list installations: ${stringifyError(error)}`,
    );
  });

  const parsed = GitHubUserInstallationsResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new GitHubAppError(
      "OAUTH_INVALID_RESPONSE",
      `Invalid installations response: ${parsed.error.message}`,
    );
  }
  return parsed.data.installations;
}

/**
 * Create GitHub App provider. Returns undefined if env vars missing.
 *
 * Required env vars:
 * - GITHUB_APP_ID_FILE (numeric App ID for JWT signing)
 * - GITHUB_APP_CLIENT_ID_FILE (OAuth Client ID for code exchange)
 * - GITHUB_APP_CLIENT_SECRET_FILE
 * - GITHUB_APP_PRIVATE_KEY_FILE
 * - GITHUB_APP_INSTALLATION_URL
 */
export function createGitHubAppInstallProvider(): AppInstallProvider | undefined {
  const appIdFile = env.GITHUB_APP_ID_FILE;
  const clientIdFile = env.GITHUB_APP_CLIENT_ID_FILE;
  const clientSecretFile = env.GITHUB_APP_CLIENT_SECRET_FILE;
  const privateKeyFile = env.GITHUB_APP_PRIVATE_KEY_FILE;
  const installationUrl = env.GITHUB_APP_INSTALLATION_URL;

  if (!appIdFile || !clientIdFile || !clientSecretFile || !privateKeyFile || !installationUrl) {
    return undefined;
  }

  let appId: string;
  let clientId: string;
  let clientSecret: string;
  let privateKey: string;

  try {
    appId = readFileSync(appIdFile, "utf-8").trim();
    clientId = readFileSync(clientIdFile, "utf-8").trim();
    clientSecret = readFileSync(clientSecretFile, "utf-8").trim();
    privateKey = readFileSync(privateKeyFile, "utf-8");
  } catch (err) {
    logger.warn(`Failed to read GitHub App credentials: ${stringifyError(err)}`);
    return undefined;
  }

  const oauthAuth = createOAuthAppAuth({ clientId, clientSecret, clientType: "github-app" });

  const appAuth = createAppAuth({ appId, privateKey });

  return defineAppInstallProvider({
    id: "github",
    platform: "github",
    displayName: "GitHub",
    description: "Install Friday GitHub App",
    docsUrl: "https://docs.hellofriday.ai/capabilities-and-integrations/git-hub",

    buildAuthorizationUrl(_callbackUrl, state) {
      const url = new URL(installationUrl);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeInstallation(code, _callbackUrl, callbackParams) {
      // 1. Get installation_id from callback
      const installationId = Number(callbackParams?.get("installation_id"));
      if (!(installationId > 0)) {
        throw new GitHubAppError(
          "INSTALLATION_ID_INVALID",
          `Invalid or missing installation_id: ${callbackParams?.get("installation_id")}`,
          400,
        );
      }

      // 2. Exchange code for user token (proves user initiated flow)
      const authResult = await oauthAuth({ type: "oauth-user", code }).catch((error) => {
        throw new GitHubAppError(
          "OAUTH_CODE_EXCHANGE_FAILED",
          `OAuth code exchange failed: ${stringifyError(error)}`,
        );
      });
      const userToken = authResult.token;

      // 3. Verify user has access to this installation
      const installations = await listUserInstallations(userToken);
      const installation = installations.find((i) => i.id === installationId);
      if (!installation) {
        throw new GitHubAppError(
          "INSTALLATION_NOT_FOUND",
          `User does not have access to installation ${installationId}`,
          403,
        );
      }

      // 4. Mint initial installation token
      const installationAuth = await appAuth({ type: "installation", installationId }).catch(
        (error) => {
          throw new GitHubAppError(
            "TOKEN_MINT_FAILED",
            `Token mint failed: ${stringifyError(error)}`,
          );
        },
      );

      // 5. Return credential
      const expiresAt = Math.floor(new Date(installationAuth.expiresAt).getTime() / 1000);
      return {
        externalId: String(installationId),
        externalName: installation.account.login,
        credential: {
          type: "oauth",
          provider: "github",
          label: installation.account.login,
          secret: {
            platform: "github",
            externalId: String(installationId),
            access_token: installationAuth.token,
            expires_at: expiresAt,
            github: {
              installationId,
              organizationName: installation.account.login,
              organizationId: installation.account.id,
            },
          },
        },
      };
    },

    async refreshToken(secret) {
      if (secret.platform !== "github") {
        throw new AppInstallError(
          "INVALID_CREDENTIAL",
          `Expected github platform, got: ${secret.platform}`,
        );
      }

      const installationAuth = await appAuth({
        type: "installation",
        installationId: secret.github.installationId,
      }).catch((error) => {
        throw new AppInstallError(
          "REFRESH_ERROR",
          `Token refresh failed: ${stringifyError(error)}`,
        );
      });

      return {
        access_token: installationAuth.token,
        expires_at: Math.floor(new Date(installationAuth.expiresAt).getTime() / 1000),
      };
    },
  });
}
