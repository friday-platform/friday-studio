import { z } from "zod";

// Credential type enum
export const CredentialTypeSchema = z.enum(["apikey", "oauth"]);

/**
 * OAuth credential secret schema.
 * Stores OAuth tokens with optional refresh and expiration metadata.
 */
const OAuthCredentialSecretSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.string().default("Bearer"),
  expires_at: z.number().optional(), // Unix timestamp (seconds)
  granted_scopes: z.array(z.string()).optional(), // what was actually authorized
  client_id: z.string().optional(), // for dynamic OAuth refresh
});

// Metadata - timestamps for credential lifecycle tracking
const MetadataSchema = z.object({ createdAt: z.string(), updatedAt: z.string() });

export type Metadata = z.infer<typeof MetadataSchema>;

// What gets stored and retrieved
export const CredentialSchema = z.object({
  id: z.string(),
  type: CredentialTypeSchema,
  provider: z.string(), // "openai", "github", etc.
  label: z.string(), // user-friendly name
  secret: z.record(z.string(), z.unknown()),
  metadata: MetadataSchema,
});

export type Credential = z.infer<typeof CredentialSchema>;

/**
 * OAuth credential schema for credentials obtained via OAuth flow.
 * Uses synthetic ID for upsert: "oauth:${provider}:${userIdentifier}"
 */
const OAuthCredentialSchema = z.object({
  id: z.string(), // synthetic: "oauth:${provider}:${userIdentifier}"
  type: z.literal("oauth"),
  provider: z.string(),
  userIdentifier: z.string(), // email, sub, or account ID - uniqueness key
  label: z.string(), // display label (required, defaults to userIdentifier in service)
  secret: OAuthCredentialSecretSchema,
  metadata: MetadataSchema,
});

export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

// What you get when LISTING (no secrets)
export const CredentialSummarySchema = CredentialSchema.omit({ secret: true });
export type CredentialSummary = z.infer<typeof CredentialSummarySchema>;

// Storage adapter interface - multi-tenant with userId scoping
export interface StorageAdapter {
  save(credential: Credential, userId: string): Promise<void>;
  get(id: string, userId: string): Promise<Credential | null>;
  list(type: string, userId: string): Promise<CredentialSummary[]>;
  delete(id: string, userId: string): Promise<void>;
}

/**
 * Request body for PUT /v1/credentials/:type
 * Service generates id, type comes from URL, metadata is auto-generated
 */
export const CredentialCreateRequestSchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1),
  secret: z.record(z.string(), z.unknown()),
});

/**
 * Client registration details for OAuth provider.
 * Stored on pending flow to ensure callback uses same config that built auth URL.
 */
export type ClientRegistration = {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
};
