# SendGrid Custom Headers Implementation Plan

## Overview

This document outlines the implementation plan for adding custom headers to all emails sent through
SendGrid in the Atlas platform. These headers will provide traceability and debugging capabilities
by including Atlas version, user information, and hostname.

## Custom Headers to Implement

- `X-Atlas-Version`: Atlas version (e.g., "dev-4accf10", "1.0.0", "nightly-abc123")
- `X-Atlas-User`: User email extracted from Atlas JWT key
- `X-Atlas-Hostname`: Machine hostname where Atlas is running

## Current Architecture Analysis

### Key Components

1. **SendGrid Provider**: `packages/notifications/src/providers/sendgrid-provider.ts`
   - Main email sending implementation using `@sendgrid/mail` package
   - `buildEmailMessage()` method constructs the SendGrid message object
   - Currently sends emails without custom headers

2. **MCP Email Tool**: `packages/mcp-server/src/tools/notifications/email.ts`
   - Exposed tool for agents to send emails
   - Creates NotificationManager with SendGrid configuration
   - Passes email parameters to the provider

3. **Version Detection**: `src/utils/version.ts`
   - `getAtlasVersion()` returns version string based on context
   - Handles dev, nightly, and release builds

4. **JWT Handling**: `packages/core/src/credential-fetcher.ts`
   - JWT validation and parsing
   - Extracts user email from JWT payload

## Implementation Steps

### Step 1: Update SendGrid Provider to Support Custom Headers

**File**: `packages/notifications/src/providers/sendgrid-provider.ts`

**Changes**:

1. Add custom headers to the `buildEmailMessage()` method
2. Extract user information from Atlas key if available
3. Add hostname detection
4. Include Atlas version

```typescript
private buildEmailMessage(params: EmailParams): sgMail.MailDataRequired {
  const message: Record<string, unknown> = {
    // ... existing fields ...
  };

  // Add custom headers for Atlas tracking
  message.headers = this.buildCustomHeaders();

  return message;
}

private buildCustomHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  // Add Atlas version
  headers["X-Atlas-Version"] = getAtlasVersion();

  // Add hostname
  try {
    headers["X-Atlas-Hostname"] = Deno.hostname();
  } catch {
    headers["X-Atlas-Hostname"] = "unknown";
  }

  // Add user from Atlas key if available
  const atlasKey = Deno.env.get("ATLAS_KEY");
  if (atlasKey) {
    const userEmail = this.extractUserFromJWT(atlasKey);
    if (userEmail) {
      headers["X-Atlas-User"] = userEmail;
    }
  }

  return headers;
}

private extractUserFromJWT(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1]!));
    return payload.email || null;
  } catch {
    return null;
  }
}
```

### Step 2: Import Required Dependencies

**File**: `packages/notifications/src/providers/sendgrid-provider.ts`

**Add imports**:

```typescript
import { getAtlasVersion } from "../../../src/utils/version.ts";
```

### Step 3: Update MCP Email Tool Context

**File**: `packages/mcp-server/src/tools/notifications/email.ts`

**Optional Enhancement**: Pass additional context through tool context if needed. The current
implementation will work as-is since the provider will read environment variables directly.

### Step 4: Add Tests

**File**: `packages/notifications/tests/sendgrid-integration.test.ts`

**Add tests for**:

1. Verify custom headers are included in messages
2. Test JWT parsing for user extraction
3. Test graceful handling when ATLAS_KEY is not present
4. Verify hostname detection

## Technical Considerations

### SendGrid API Support

According to the SendGrid API documentation, custom headers are supported through the `headers`
field in the message object. The API accepts headers as a simple object with string key-value pairs.

### Security Considerations

1. **JWT Validation**: The JWT is only parsed, not validated (signature verification not needed for
   extracting email)
2. **PII Protection**: User email is already present in the "from" field for most emails
3. **Header Size**: Keep headers concise to avoid email size issues

### Error Handling

1. **Missing ATLAS_KEY**: Headers will be added without user information
2. **Invalid JWT**: Gracefully skip user extraction
3. **Hostname errors**: Default to "unknown" if hostname cannot be determined

## Testing Plan

### Unit Tests

1. Test header construction with valid Atlas key
2. Test header construction without Atlas key
3. Test JWT parsing edge cases
4. Test hostname detection

### Integration Tests

1. Send test email and verify headers in SendGrid dashboard
2. Test with different Atlas versions (dev, nightly, release)
3. Test with different environments (local, CI, production)

### Manual Testing

1. Send email through Atlas MCP tool
2. Check SendGrid Activity Feed for custom headers
3. Verify headers in email source (if using test recipients)

## Rollout Plan

### Phase 1: Development Testing

1. Implement changes in development environment
2. Test with sandbox mode enabled
3. Verify headers appear correctly

### Phase 2: Staging Validation

1. Deploy to staging environment
2. Test with real SendGrid account
3. Monitor for any issues

### Phase 3: Production Deployment

1. Deploy to production
2. Monitor SendGrid logs for header presence
3. Use headers for debugging and tracking

## Monitoring and Observability

### Metrics to Track

1. Email send success rate (ensure no regression)
2. Header presence in SendGrid logs
3. Performance impact (should be negligible)

### Debugging Benefits

1. **Version Tracking**: Identify which Atlas version sent an email
2. **User Attribution**: Track which user's Atlas instance sent emails
3. **Environment Identification**: Determine source machine/environment

## Alternative Approaches Considered

### 1. Pass Headers Through Email Parameters

- **Pros**: More explicit, easier to test
- **Cons**: Requires changes to all email sending code, breaks existing API

### 2. Use SendGrid Metadata Fields

- **Pros**: Built-in SendGrid feature
- **Cons**: Not visible in email headers, only in SendGrid dashboard

### 3. Configuration-Based Headers

- **Pros**: Flexible, configurable per provider
- **Cons**: More complex, requires configuration changes

## Conclusion

The proposed implementation adds valuable tracking information to all SendGrid emails with minimal
code changes. The solution is backward-compatible, secure, and provides immediate debugging
benefits.

## Implementation Checklist

- [x] Update SendGrid provider with custom headers support
- [x] Add required imports and dependencies
- [x] Implement JWT parsing for user extraction (with Zod validation)
- [x] Add comprehensive tests
- [x] Test in development environment
- [ ] Document header usage for team
- [ ] Deploy to staging
- [ ] Monitor and validate
- [ ] Deploy to production

## Implementation Progress

### Implementation Details

**Files Modified:**

- `packages/notifications/src/providers/sendgrid-provider.ts`
  - Added Zod import and AtlasJWTPayloadSchema
  - Implemented `buildCustomHeaders()` method
  - Implemented `extractUserFromJWT()` with Zod validation
  - Modified `buildEmailMessage()` to include headers

**Files Created:**

- `packages/notifications/tests/sendgrid-custom-headers.test.ts`
  - Comprehensive test suite for custom headers functionality
  - 11 test cases covering all scenarios

### Completed Enhancements (Beyond Original Plan)

1. **Improved JWT Parsing with Zod Validation**
   - Used Zod schema for type-safe JWT validation
   - Added email format validation with `z.string().email()`
   - Proper base64url decoding (handles `-` and `_` characters)
   - Graceful error handling with `safeParse()`

2. **Comprehensive Test Coverage**
   - Created `sendgrid-custom-headers.test.ts` with 11 test cases
   - Tests cover all header scenarios (with/without ATLAS_KEY)
   - Edge case testing for JWT parsing
   - Integration test for complete email flow
   - All tests passing successfully

3. **Production-Ready Implementation**
   - Headers added transparently to all emails
   - No breaking changes to existing API
   - Proper error handling and fallbacks
   - Clean, maintainable code with TypeScript

## Next Steps for Team

### Ready for Deployment

The implementation is complete and tested. The custom headers will automatically be added to all
SendGrid emails once deployed. No configuration changes are required.

### How to Verify Headers in Production

1. **SendGrid Activity Feed**:
   - Navigate to https://app.sendgrid.com/email_activity
   - Click on any sent email to view details
   - Look for headers in the "Additional Details" section:
     - `X-Atlas-Version`: Shows Atlas version (e.g., "dev-abc123", "1.0.0")
     - `X-Atlas-Hostname`: Shows the sending machine hostname
     - `X-Atlas-User`: Shows user email if ATLAS_KEY is present

2. **Email Source**:
   - View the raw email source in email clients
   - Custom headers will appear in the SMTP headers section

### Usage Notes

- Headers are added automatically - no code changes needed in email sending logic
- If ATLAS_KEY is not present, only version and hostname headers are added
- Invalid or expired JWTs gracefully skip user header addition
- All headers use the `X-Atlas-` prefix to avoid conflicts
