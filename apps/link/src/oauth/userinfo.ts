import { z } from "zod/v4";

/**
 * OIDC UserInfo response schema
 * @see https://openid.net/specs/openid-connect-core-1_0.html#UserInfo
 */
export const OidcUserInfoSchema = z
  // Loose to allow additional claims
  .looseObject({
    sub: z.string(), // Required per OIDC spec
    email: z.email().optional(),
    email_verified: z.boolean().optional(),
    name: z.string().optional(),
    given_name: z.string().optional(),
    family_name: z.string().optional(),
    picture: z.url().optional(),
    locale: z.string().optional(),
  });

export type OidcUserInfo = z.infer<typeof OidcUserInfoSchema>;

/**
 * Extract a stable identifier from userinfo
 * Prefers email if available, falls back to sub
 */
export function extractIdentifier(userinfo: OidcUserInfo): string {
  return userinfo.email ?? userinfo.sub;
}
