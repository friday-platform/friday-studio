import { createPrivateKey } from "node:crypto";
import { stringifyError } from "@atlas/utils";
import * as jose from "jose";
import { z } from "zod";
import { defineApiKeyProvider, type HealthResult } from "./types.ts";

/**
 * GitHub App apikey provider.
 *
 * The user pastes `app_id`, `private_key` (PEM), `webhook_secret`, and
 * `installation_id` from the GitHub App settings page. `bot_user_slug` and
 * `bot_user_id` are populated server-side at credential-save time by
 * `health()` and surfaced via `HealthResult.metadata`; the credentials route
 * merges them into the stored secret. Field names use snake_case to match
 * the rest of the Link provider secrets (`bot_token`, `app_id`, etc.).
 *
 * **Trust contract:** if `health()` resolves with `{ healthy: true }`, the
 * four user-supplied fields produce a working installation client and the
 * returned `metadata.bot_user_slug` / `metadata.bot_user_id` are valid
 * identifiers for the App's bot user. `webhook_secret` is **not** validated —
 * there is no GitHub API surface to probe it; the first real webhook is the
 * de-facto check.
 *
 * **Webhook URL:** the daemon serves a single `/platform/github` route and
 * dispatches to a workspace using `installation.id` from the event body
 * (matches slack/teams/whatsapp body-routing). The instructions therefore
 * point users at `<callbackBaseUrl>/platform/github` with no per-installation
 * segment — the routing key lives in the payload, not the path.
 *
 * **Bot-user capture (`[bot]` suffix and `bot_user_id`):** GitHub webhook
 * payloads carry `comment.user.login` in `<slug>[bot]` form for App-authored
 * comments (literal four-character `[bot]` suffix). We store `bot_user_slug`
 * with the suffix so it matches webhook payloads byte-for-byte. `bot_user_id`
 * is the numeric user ID and is rename-immune — if the App is renamed on
 * github.com, the slug goes stale (re-save in Link to refresh) but the ID
 * remains the durable identifier.
 */
export const GithubAppSecretSchema = z.object({
  app_id: z.number().int().positive(),
  // `format: "multiline"` is a Friday convention surfaced via `z.toJSONSchema`
  // so the playground form renders this as a `<textarea>` instead of a
  // `<input type="password">` (single-line inputs strip pasted PEM newlines).
  private_key: z
    .string()
    .refine(
      (pem) =>
        pem.includes("-----BEGIN RSA PRIVATE KEY-----") ||
        pem.includes("-----BEGIN PRIVATE KEY-----"),
      {
        message:
          "private_key must be a PEM-encoded RSA key (BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY)",
      },
    )
    .meta({ format: "multiline" }),
  webhook_secret: z.string().min(1),
  installation_id: z.number().int().positive(),
});

/** Subset of GitHub `GET /app` response we consume. */
const GithubAppResponseSchema = z.object({ slug: z.string().min(1) });

/** Subset of GitHub `GET /app/installations/{id}` response we consume. */
const GithubInstallationResponseSchema = z.object({ id: z.number() });

/** Subset of GitHub `GET /users/{login}` response we consume. */
const GithubBotUserResponseSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
});

/**
 * Sign a GitHub App JWT (RS256) using the App's PEM private key.
 *
 * Per GitHub Apps docs, the JWT is signed with **RS256** (not ES256) and
 * carries `iss = String(app_id)`, `iat = now - 60s` (clock-skew buffer), and
 * `exp = now + 9m` (GitHub's documented max is 10m, leave a 1m buffer).
 */
async function signAppJwt(appId: number, privateKeyPem: string): Promise<string> {
  // GitHub App private keys are typically distributed as PKCS1 PEM
  // (BEGIN RSA PRIVATE KEY) but newer keys and openssl-converted keys may be
  // PKCS8 (BEGIN PRIVATE KEY). `node:crypto`'s createPrivateKey accepts both
  // forms; round-tripping through PKCS8 PEM gives jose a key it can import
  // without hand-rolling PKCS1→PKCS8 conversion.
  const keyObject = createPrivateKey({ key: privateKeyPem, format: "pem" });
  // `format: "pem"` returns a string under deno-types' Node declarations; if a
  // future runtime returns a Buffer we'd need to coerce, but the current
  // typing narrows to `string`.
  const pkcs8Pem = keyObject.export({ format: "pem", type: "pkcs8" });
  const privateKey = await jose.importPKCS8(pkcs8Pem, "RS256");

  const nowSec = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(String(appId))
    .setIssuedAt(nowSec - 60)
    .setExpirationTime(nowSec + 9 * 60)
    .sign(privateKey);
}

/** Common headers for GitHub REST API calls. */
function githubHeaders(jwt: string): HeadersInit {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atlas-link",
  };
}

export const githubAppProvider = defineApiKeyProvider({
  id: "github-app",
  displayName: "GitHub App",
  description: "Connect a GitHub App to receive webhooks and post comments as the App",
  docsUrl: "https://docs.github.com/en/apps/creating-github-apps",
  secretSchema: GithubAppSecretSchema,
  setupInstructions: `
1. Go to [GitHub Settings → Developer settings → GitHub Apps](https://github.com/settings/apps/new) (or your org's equivalent) and click **New GitHub App**
2. **Repository permissions:** \`Contents: Read & write\`, \`Issues: Read & write\`, \`Pull requests: Read & write\`, \`Metadata: Read-only\`
3. **Subscribe to events:** \`Issue comment\`, \`Pull request review comment\`, \`Pull request\`, \`Issues\`
4. Set **Webhook URL** to \`<callbackBaseUrl>/platform/github\` and pick a strong **Webhook secret** (a long random string)
5. Click **Create GitHub App**, then under the new App's **General → Private keys**, click **Generate a private key** and download the \`.pem\` file
6. Under **Install App**, install it on the org/user account that owns the repos you want Friday to act on. After installing, the URL will look like \`https://github.com/settings/installations/<INSTALLATION_ID>\` — copy that numeric ID
7. From the App's **General** page, copy the **App ID** (numeric)
8. Paste \`app_id\`, the contents of the \`.pem\` file as \`private_key\`, the \`webhook_secret\` you chose, and the \`installation_id\` below — Friday will validate the credentials and capture the App's bot user identity automatically
9. After saving, return to the GitHub App settings and confirm the webhook URL is still \`<callbackBaseUrl>/platform/github\`. Friday does not register the URL upstream — pasting it once during App creation is the simplest contract.
`,
  health: async (secret): Promise<HealthResult> => {
    try {
      const jwt = await signAppJwt(secret.app_id, secret.private_key);
      const headers = githubHeaders(jwt);

      const appRes = await fetch("https://api.github.com/app", { headers });
      if (!appRes.ok) {
        return {
          healthy: false,
          error: `GitHub /app returned ${appRes.status} (check app_id and private_key)`,
        };
      }
      const appBody = GithubAppResponseSchema.parse(await appRes.json());

      const installRes = await fetch(
        `https://api.github.com/app/installations/${secret.installation_id}`,
        { headers },
      );
      if (!installRes.ok) {
        return {
          healthy: false,
          error: `GitHub /app/installations/${secret.installation_id} returned ${installRes.status} (check installation_id matches this App)`,
        };
      }
      // Parse to validate shape but discard — we only need the status check.
      GithubInstallationResponseSchema.parse(await installRes.json());

      const botSlug = `${appBody.slug}[bot]`;
      const botRes = await fetch(`https://api.github.com/users/${encodeURIComponent(botSlug)}`, {
        headers,
      });
      if (!botRes.ok) {
        return {
          healthy: false,
          error: `GitHub /users/${botSlug} returned ${botRes.status} (App configured but bot user not yet provisioned)`,
        };
      }
      const botBody = GithubBotUserResponseSchema.parse(await botRes.json());

      return { healthy: true, metadata: { bot_user_slug: botSlug, bot_user_id: botBody.id } };
    } catch (e) {
      return { healthy: false, error: stringifyError(e) };
    }
  },
});
