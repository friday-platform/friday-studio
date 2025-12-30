/**
 * Email Recipient Validation
 *
 * Validates and potentially overrides the recipient email address based on
 * the sender's email domain:
 *
 * - Public domain users (gmail, yahoo, etc.): Can only send to themselves
 * - Company domain users: Can send to themselves or anyone in the same domain
 *
 * When a recipient is outside the allowed scope, it's silently overridden
 * to the sender's own email address.
 */

import { extractDomain, isPublicEmailDomain } from "./public-domains.ts";

/**
 * Result of recipient validation.
 * Always succeeds - invalid recipients are overridden, not rejected.
 */
export type RecipientValidationResult = {
  /** The final recipient email address (may be overridden) */
  to: string;
  /** Whether the original recipient was overridden */
  overridden: boolean;
};

/**
 * Validate and potentially override the recipient email address.
 *
 * Rules:
 * - If sender is on a public domain: recipient is always set to sender's email
 * - If sender is on a company domain: recipient must be on the same domain,
 *   otherwise it's overridden to sender's email
 *
 * @param userEmail - The authenticated user's email address
 * @param requestedTo - The recipient email address from the LLM composition
 * @returns Validation result with final recipient and override flag
 */
export function validateRecipient(
  userEmail: string,
  requestedTo: string,
): RecipientValidationResult {
  const normalizedUserEmail = userEmail.toLowerCase();
  const normalizedRequestedTo = requestedTo.toLowerCase();
  const userDomain = extractDomain(normalizedUserEmail);

  // Public domain users can only send to themselves
  if (isPublicEmailDomain(userDomain)) {
    const isSelf = normalizedRequestedTo === normalizedUserEmail;
    return { to: normalizedUserEmail, overridden: !isSelf };
  }

  // Company domain users can send to same domain or themselves
  const requestedDomain = extractDomain(normalizedRequestedTo);
  if (requestedDomain === userDomain) {
    return { to: normalizedRequestedTo, overridden: false };
  }

  // Outside domain - override to self
  return { to: normalizedUserEmail, overridden: true };
}
