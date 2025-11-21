# Atlas Authentication Migration Plan - Port from Tempest

## Executive Summary

This document outlines the direct port of Tempest's Go-based authentication service to Atlas. The plan focuses on **reusing the existing, battle-tested Go code** with minimal modifications to support Atlas's requirements: removing organization support, maintaining JWT format compatibility, and integrating the Go service into Atlas's monorepo.

## 1. Port Strategy

### Core Principle: Maximum Code Reuse

**What we're porting directly**:
- The entire `bounce` service from tempest-core
- Database schema (simplified to remove organizations)
- JWT signing/verification logic
- OTP token generation and validation
- Email sending logic
- Session management
- Security validations (email domain blocking, etc.)

**What we're modifying**:
- Remove organization-related code
- Simplify JWT claims (no org context)
- Update configuration for Atlas URLs
- Integrate with Atlas's monorepo structure
- Adapt Kubernetes deployments for Atlas

**What we're NOT doing**:
- Rewriting in TypeScript
- Changing authentication methods
- Modifying security patterns
- Altering the database architecture significantly

## 2. Go Service Integration in Atlas Monorepo

### Directory Structure

```
atlas/
├── deno.json                    # Existing Deno workspace
├── package.json                 # Existing npm workspace
├── go.mod                       # NEW - Go module for auth service
├── go.sum                       # NEW - Go dependencies
├── Makefile                     # NEW - Go build targets
├── .golangci.yml               # NEW - Go linting config
│
├── apps/                        # All applications (Deno, Go, etc.)
│   ├── atlas-installer/         # Existing - Tauri installer
│   ├── atlasd/                  # Existing - Deno daemon
│   ├── web-client/              # Existing - SvelteKit UI
│   └── bounce/                  # NEW - Auth service (keep Tempest name)
│       ├── main.go
│       ├── service/
│       │   ├── auth.go
│       │   ├── jwt.go
│       │   ├── otp.go
│       │   └── session.go
│       ├── repo/
│       │   ├── sqlc.yaml
│       │   ├── query.sql
│       │   ├── schema.sql
│       │   └── generated/     # sqlc generated code
│       ├── handlers/
│       │   ├── signup.go
│       │   ├── login.go
│       │   └── session.go
│       └── Dockerfile
│
└── packages/                   # Shared packages (Deno)
```

### Go Module Setup

```go
// go.mod
module github.com/tempestteam/atlas

go 1.25.4

require (
    github.com/MicahParks/keyfunc/v3 v3.3.5
    github.com/go-chi/chi/v5 v5.2.0
    github.com/go-chi/httplog/v2 v2.1.1
    github.com/golang-jwt/jwt/v5 v5.2.1
    github.com/google/uuid v1.6.0
    github.com/jackc/pgx/v5 v5.7.5
    github.com/jackc/pgxpool/v5 v5.7.5
    github.com/jmoiron/sqlx v1.4.0
    github.com/kelseyhightower/envconfig v1.4.0
    github.com/lib/pq v1.10.9
    github.com/rs/cors v1.11.1
    github.com/sendgrid/sendgrid-go v3.16.0+incompatible
    github.com/shopspring/decimal v1.4.0
    github.com/stretchr/testify v1.10.0
    golang.org/x/crypto v0.31.0
    golang.org/x/oauth2 v0.25.0
)
```

### Makefile

```makefile
# Makefile
.PHONY: build test lint

# Build variables
GO := go
GOFLAGS := -v
CGO_ENABLED := 0
BUILD_DIR := build

# Build bounce service
build-bounce:
	@echo "Building bounce service..."
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=$(CGO_ENABLED) $(GO) build $(GOFLAGS) \
		-o $(BUILD_DIR)/bounce \
		./apps/bounce

# Run bounce service locally
run-bounce:
	$(GO) run ./apps/bounce

# Test bounce service
test-bounce:
	$(GO) test -v -race ./apps/bounce/...

# Generate sqlc code
generate-bounce:
	cd apps/bounce/repo && sqlc generate

# Lint Go code
lint:
	golangci-lint run ./apps/bounce/...

# Build all Go services
build-go: build-bounce

# Test all Go services
test-go: test-bounce

# Docker build for bounce
docker-bounce:
	docker build -f apps/bounce/Dockerfile -t atlas-bounce .
```

## 3. Database Schema and Migration Strategy

### Migration via Supabase

Database migrations are managed through Supabase:
1. Create migration files in `supabase/migrations/`
2. Apply using Supabase CLI: `supabase db push`
3. Migrations run in transaction with automatic rollback on failure

### Complete Schema (Atlas-Specific, No Organizations)

```sql
-- Required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create schemas
CREATE SCHEMA IF NOT EXISTS bounce;
CREATE SCHEMA IF NOT EXISTS _tempest;

-- ID encode function (from tempest-core) - generates base62 strings
CREATE OR REPLACE FUNCTION public.id_encode(number bigint, alphabet text, min_length integer)
RETURNS text AS $$
DECLARE
    output text := '';
    alphabet_len integer := length(alphabet);
    val bigint := number;
BEGIN
    IF val < 0 THEN
        RAISE EXCEPTION 'Number must be positive';
    END IF;

    LOOP
        output := substr(alphabet, (val % alphabet_len) + 1, 1) || output;
        val := val / alphabet_len;
        EXIT WHEN val = 0;
    END LOOP;

    -- Pad to minimum length
    WHILE length(output) < min_length LOOP
        output := substr(alphabet, 1, 1) || output;
    END LOOP;

    RETURN output;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Short ID generation (MODIFIED FOR ATLAS)
-- Creates base36-encoded IDs using only lowercase letters and digits
-- This eliminates the need for hex conversion in routing!
-- Example: '6bd8e78lgpqzw' can be used directly in Traefik headers
CREATE OR REPLACE FUNCTION _tempest.shortid() RETURNS text AS $$
DECLARE
    random_bigint bigint;
    encoded_id text;
BEGIN
    -- Generate a random bigint
    SELECT ('x' || encode(gen_random_bytes(8), 'hex'))::bit(64)::bigint INTO random_bigint;

    -- Encode using base36 alphabet (digits + lowercase letters ONLY)
    -- This allows IDs to be used directly in HTTP headers without conversion
    SELECT public.id_encode(random_bigint,
        '0123456789abcdefghijklmnopqrstuvwxyz', 10)
    INTO encoded_id;

    RETURN encoded_id;
END;
$$ LANGUAGE plpgsql;

-- Updated timestamp trigger function
CREATE OR REPLACE FUNCTION _tempest.updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- bounce.auth_user - Core auth table
CREATE TABLE bounce.auth_user (
    id text PRIMARY KEY DEFAULT _tempest.shortid(),
    email text NOT NULL UNIQUE,
    email_confirmed boolean NOT NULL DEFAULT false,
    email_confirmed_at timestamptz,
    confirmation_token text,
    confirmation_sent_at timestamptz,
    last_sign_in_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trigger_update_updated_at_auth_user
    BEFORE UPDATE ON bounce.auth_user
    FOR EACH ROW EXECUTE FUNCTION _tempest.updated_at();

-- OAuth identity providers
CREATE TYPE bounce_identity_provider AS ENUM ('google');

-- bounce.identity - OAuth identities
CREATE TABLE bounce.identity (
    id text PRIMARY KEY DEFAULT _tempest.shortid(),
    auth_user_id text REFERENCES bounce.auth_user (id) ON DELETE CASCADE,
    email text NOT NULL,
    provider bounce_identity_provider NOT NULL,
    provider_id text NOT NULL,  -- Google user ID
    provider_app_data jsonb NOT NULL DEFAULT '{}',
    provider_user_data jsonb NOT NULL DEFAULT '{}',
    last_sign_in_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_id, email),
    UNIQUE (provider, email)
);

CREATE TRIGGER trigger_update_updated_at_identity
    BEFORE UPDATE ON bounce.identity
    FOR EACH ROW EXECUTE FUNCTION _tempest.updated_at();

-- OTP uses
CREATE TYPE bounce_otp_use AS ENUM ('magiclink', 'emailconfirm', 'oauthstate', 'csrf');

-- bounce.otp - One-time passwords/tokens
CREATE TABLE bounce.otp (
    id text PRIMARY KEY DEFAULT _tempest.shortid(),
    token text NOT NULL UNIQUE,
    auth_user_id text REFERENCES bounce.auth_user (id) ON DELETE CASCADE,
    use bounce_otp_use NOT NULL,
    not_valid_after timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Atlas application user table (NO organizations!)
CREATE TABLE public."user" (
    id text PRIMARY KEY DEFAULT _tempest.shortid(),
    bounce_auth_user_id text NOT NULL UNIQUE REFERENCES bounce.auth_user (id),
    email text NOT NULL,
    full_name text NOT NULL,
    display_name text,
    profile_photo text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_sign_in_at timestamptz
);

CREATE TRIGGER trigger_update_updated_at_user
    BEFORE UPDATE ON public."user"
    FOR EACH ROW EXECUTE FUNCTION _tempest.updated_at();

-- Indexes for performance
CREATE INDEX idx_auth_user_email ON bounce.auth_user(email);
CREATE INDEX idx_auth_user_confirmation_token ON bounce.auth_user(confirmation_token);
CREATE INDEX idx_otp_token ON bounce.otp(token);
CREATE INDEX idx_otp_auth_user ON bounce.otp(auth_user_id);
CREATE INDEX idx_identity_provider ON bounce.identity(provider, email);
CREATE INDEX idx_user_email ON public."user"(email);
CREATE INDEX idx_user_bounce_auth ON public."user"(bounce_auth_user_id);
```

## 4. Code Modifications

### SQLC Query Files

Create the SQLC query file for database operations:

```sql
-- apps/bounce/repo/query.sql
```

Create the SQLC configuration file:

```yaml
# apps/bounce/repo/sqlc.yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "query.sql"
    schema: "../../../supabase/migrations/*.sql"
    gen:
      go:
        package: "repo"
        out: "."
        sql_package: "pgx/v5"
        emit_interface: true
        emit_json_tags: true
        emit_db_tags: true
        emit_prepared_queries: false
        emit_exact_table_names: false
        overrides:
          - db_type: "timestamptz"
            go_type: "time.Time"
          - db_type: "jsonb"
            go_type: "json.RawMessage"
```

And the query file:

```sql
-- apps/bounce/repo/query.sql

-- name: AuthUserByEmail :one
SELECT * FROM bounce.auth_user WHERE email = $1;

-- name: AuthUserByConfirmationToken :one
SELECT * FROM bounce.auth_user WHERE confirmation_token = $1;

-- name: AuthUserByID :one
SELECT * FROM bounce.auth_user WHERE id = $1;

-- name: SaveUnconfirmedAuthUser :one
INSERT INTO bounce.auth_user (email, confirmation_token, confirmation_sent_at)
VALUES ($1, $2, $3)
ON CONFLICT (email) DO UPDATE
SET confirmation_token = $2,
confirmation_sent_at = $3
RETURNING *;

-- name: SaveConfirmedAuthUser :one
INSERT INTO bounce.auth_user (email, email_confirmed, email_confirmed_at)
VALUES ($1, true, now())
RETURNING *;

-- name: ConfirmAuthUser :one
UPDATE bounce.auth_user
SET
    email_confirmed = true,
    email_confirmed_at = now(),
    confirmation_token = null,
    confirmation_sent_at = null
WHERE
    email = $1
    AND id = $2
RETURNING *;

-- name: CreateAtlasUser :one
INSERT INTO public."user" (bounce_auth_user_id, email, full_name, display_name, profile_photo)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: UpdateAtlasUser :one
UPDATE public."user"
SET
    full_name = $2,
    display_name = $3,
    profile_photo = $4
WHERE bounce_auth_user_id = $1
RETURNING *;

-- name: GetAtlasUserByAuthID :one
SELECT * FROM public."user" WHERE bounce_auth_user_id = $1;

-- name: GetAtlasUserByID :one
SELECT * FROM public."user" WHERE id = $1;

-- name: CreateIdentity :exec
INSERT INTO bounce.identity (auth_user_id, email, provider, provider_id, provider_user_data)
VALUES ($1, $2, $3, $4, $5);

-- name: UpdateIdentity :exec
UPDATE bounce.identity
SET
    last_sign_in_at = now(),
    provider_user_data = $4,
    updated_at = now()
WHERE provider = $1 AND provider_id = $2 AND email = $3;

-- name: GetIdentity :one
SELECT * FROM bounce.identity WHERE provider = $1 AND email = $2;

-- name: CreateOTP :one
INSERT INTO bounce.otp (token, auth_user_id, use, not_valid_after)
VALUES ($1, $2, $3, $4) RETURNING *;

-- name: GetOTP :one
SELECT * FROM bounce.otp
WHERE token = $1 AND use = $2 AND used_at IS NULL;

-- name: UseOTP :exec
UPDATE bounce.otp
SET used_at = now()
WHERE token = $1;
```

### What to Port Directly (Copy as-is)

From `tempest-core/applications/bounce/`:

1. **JWT handling** (`service/jwt.go`):
   - RS256 signing/verification
   - Key loading
   - Token generation

2. **OTP logic** (`service/otp.go`):
   - HMAC token generation
   - Validation logic
   - Expiry checking

3. **Email validation** (`service/email.go`):
   - Domain blocking logic
   - Business email validation
   - Competitor blocking

4. **Database queries** (`repo/query.sql`):
   - Most queries unchanged
   - Remove organization-related queries

5. **Email templates**:
   - SendGrid integration
   - Template IDs
   - Email formatting

### What to Modify

#### 1. Remove Organization Logic

```go
// BEFORE (Tempest)
type Claims struct {
    jwt.RegisteredClaims
    Email        string
    UserMetadata map[string]interface{} // Contains org info
    // ...
}

// AFTER (Atlas)
type Claims struct {
    jwt.RegisteredClaims
    Email        string
    UserMetadata map[string]interface{} // No org info
    // ...
}

// Remove these functions:
// - GetUserOrganizations()
// - CreateOrganization()
// - SwitchOrganization()
// - Any org-related middleware
```

#### 2. Simplify User Creation

```go
// BEFORE (Tempest)
func CompleteSignup(email, orgName, fullName string) error {
    // Create user
    // Create organization
    // Link user to org
    // Create Stripe customer
}

// AFTER (Atlas)
func CompleteSignup(email, fullName string) error {
    // Create user only
    // No org creation
    // No Stripe (Phase 1)
}
```

#### 3. Update Configuration

```go
// config.go (aligned with tempest-core/applications/bounce/service/service.go)
type Config struct {
    // Service configuration
    BounceServiceURL          string `env:"BOUNCE_SERVICE_URL" envDefault:"https://auth.atlas.tempestdx.dev"`
    Port                      string `env:"PORT" envDefault:"8083"`
    ServiceName              string `env:"SERVICE_NAME" envDefault:"bounce"`
    LogLevel                 string `env:"LOG_LEVEL" envDefault:"debug"`

    // URLs
    RedirectURI              string `env:"REDIRECT_URI" envDefault:"https://app.atlas.tempestdx.dev"`
    SignupHostname           string `env:"SIGNUP_HOSTNAME" envDefault:"https://auth.atlas.tempestdx.dev"`

    // Cookie configuration
    CookieName               string `env:"COOKIE_NAME" envDefault:"atlas_token"`
    CookieDomain            string `env:"COOKIE_DOMAIN"`  // MUST be .atlas.tempestdx.dev for subdomain sharing (auth.atlas ↔ app.atlas)

    // JWT configuration - loads from files using envconfig file tag
    JWTPrivateKey           string `env:"JWT_PRIVATE_KEY_FILE,file,required"`
    JWTPublicKey            string `env:"JWT_PUBLIC_KEY_FILE,file,required"`

    // Database
    PostgresConnection      string `env:"POSTGRES_CONNECTION" envDefault:"postgresql://postgres:postgres@postgres:5432/atlas?sslmode=disable&search_path=public,bounce"`

    // OAuth
    OAuthGoogleCredentialJSON string `env:"OAUTH_GOOGLE_CREDENTIALS_FILE,file,required"`

    // Email
    SendgridAPIKey          string `env:"SENDGRID_API_KEY_FILE,file,required"`
    EmailDomain            string `env:"EMAIL_DOMAIN" envDefault:"atlas.tempestdx.dev"`

    // Signup
    SignupHMACSecret        string `env:"SIGNUP_HMAC_SECRET,required"`

    // CORS
    CORSAllowedOrigins     string `env:"CORS_ALLOWED_ORIGINS" envDefault:"https://app.atlas.tempestdx.dev"`

    // Atlas Operator Integration
    AtlasOperatorURL        string `env:"ATLAS_OPERATOR_URL" envDefault:"http://atlas-operator:8082"`
}
```

#### 4. Database Initialization

```go
// services/bounce/service/service.go

type service struct {
    Logger  *httplog.Logger
    cfg     Config
    db      *pgxpool.Pool   // Connection pool for all operations
    queries *repo.Queries   // SQLC generated queries
}

func (s *service) Init() error {
    // Setup connection pool
    poolCfg, err := pgxpool.ParseConfig(s.cfg.PostgresConnection)
    if err != nil {
        s.Logger.Error("Failed to parse database config", "error", err)
        return err
    }

    // Configure pool settings
    poolCfg.MinConns = 5
    poolCfg.MaxConns = 20
    poolCfg.MaxConnLifetime = time.Minute * 30
    poolCfg.MaxConnIdleTime = time.Minute * 10
    poolCfg.HealthCheckPeriod = time.Minute

    // Create connection pool
    s.db, err = pgxpool.NewWithConfig(context.Background(), poolCfg)
    if err != nil {
        s.Logger.Error("Failed to connect to database", "error", err)
        return err
    }

    // Test connection
    if err := s.db.Ping(context.Background()); err != nil {
        s.Logger.Error("Failed to ping database", "error", err)
        return err
    }

    // Create SQLC queries instance
    s.queries = repo.New(s.db)

    s.Logger.Info("Database connection established",
        "minConns", poolCfg.MinConns,
        "maxConns", poolCfg.MaxConns)

    return nil
}

// Cleanup on shutdown
func (s *service) Close() {
    if s.db != nil {
        s.db.Close()
    }
}
```

#### 5. Webhook Integration with Authentication

After creating a user, bounce triggers atlas-operator for immediate instance provisioning:

```go
// services/bounce/handlers/webhook.go
func triggerAtlasOperatorRefresh(cfg Config) error {
    if cfg.AtlasOperatorURL == "" {
        return nil // Skip in development
    }

    // Generate webhook signature for authentication
    timestamp := fmt.Sprintf("%d", time.Now().Unix())
    payload := fmt.Sprintf("%s.refresh", timestamp)
    signature := generateHMAC(payload, cfg.SignupHMACSecret)  // Reuse HMAC secret

    req, err := http.NewRequest("POST", cfg.AtlasOperatorURL + "/api/v1/refresh", nil)
    if err != nil {
        return fmt.Errorf("creating webhook request: %w", err)
    }

    // Add authentication headers
    req.Header.Set("X-Webhook-Timestamp", timestamp)
    req.Header.Set("X-Webhook-Signature", signature)
    req.Header.Set("Content-Type", "application/json")

    client := &http.Client{Timeout: 5 * time.Second}
    resp, err := client.Do(req)
    if err != nil {
        return fmt.Errorf("calling webhook: %w", err)
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := io.ReadAll(resp.Body)
        return fmt.Errorf("webhook returned %d: %s", resp.StatusCode, body)
    }
    return nil
}

func generateHMAC(message, secret string) string {
    h := hmac.New(sha256.New, []byte(secret))
    h.Write([]byte(message))
    return hex.EncodeToString(h.Sum(nil))
}

// Atlas-operator webhook verification (receiver side)
func (s *Server) verifyWebhookSignature(r *http.Request) bool {
    timestamp := r.Header.Get("X-Webhook-Timestamp")
    signature := r.Header.Get("X-Webhook-Signature")

    if timestamp == "" || signature == "" {
        return false
    }

    // Check timestamp isn't too old (5 minute window)
    ts, err := strconv.ParseInt(timestamp, 10, 64)
    if err != nil {
        return false
    }
    if time.Now().Unix()-ts > 300 {
        return false  // Timestamp too old
    }

    // Verify signature (uses same secret as bounce for simplicity)
    payload := fmt.Sprintf("%s.refresh", timestamp)
    expectedSig := generateHMAC(payload, s.cfg.SignupHMACSecret)

    return hmac.Equal([]byte(signature), []byte(expectedSig))
}

// Atlas-specific signup completion (NO organizations)
func handleSignupComplete(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    log := httplog.LogEntry(ctx)

    var req struct {
        UserFullName     string `json:"userFullName" validate:"required,min=3,max=100"`
        UserProfilePhoto string `json:"userProfilePhoto" validate:"omitempty"`
    }

    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    // Get JWT from cookie
    jwt, err := TempestTokenFromCookies(&cfg, w, r)
    if err != nil {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    tc, err := ParseTempestClaimsFromJWT(cfg.JWTPublicKey, jwt)
    if err != nil {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    userID := tc.claims.Sub  // User ID from JWT
    email := tc.claims.Email

    // Begin transaction
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    defer tx.Rollback()

    // Create Atlas user (NO organization creation!)
    _, err = tx.ExecContext(ctx, `
        INSERT INTO public."user" (id, bounce_auth_user_id, email, full_name, display_name, profile_photo)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (bounce_auth_user_id)
        DO UPDATE SET
            full_name = EXCLUDED.full_name,
            display_name = EXCLUDED.display_name,
            profile_photo = EXCLUDED.profile_photo,
            updated_at = NOW()
    `, userID, userID, email, req.UserFullName, req.UserFullName, req.UserProfilePhoto)

    if err != nil {
        log.Error("Could not save user", "error", err)
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    if err = tx.Commit(); err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Trigger immediate instance creation
    go triggerAtlasOperatorRefresh(cfg)

    // Return success
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{
        "message": "User profile updated successfully",
        "redirect": cfg.RedirectURI,
    })
}
```

#### 5. OAuth Flow and Redirect Handling

The OAuth flow works as follows:
1. User clicks "Login with Google" on auth.atlas.tempestdx.dev
2. Frontend redirects to `/oauth/google/authorize?redirect_to={origin}`
3. Bounce generates state token and redirects to Google
4. Google redirects back to `/oauth/google/callback`
5. Bounce validates state, creates user, sets JWT cookie
6. Bounce redirects to the `redirect_to` URL from state

```go
// services/bounce/handlers/oauth.go

func handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
    // ... validate state and exchange code for token ...

    // After successful authentication and user creation
    // Set the JWT cookie
    http.SetCookie(w, &http.Cookie{
        Name:     "atlas_token",
        Value:    jwtToken,
        Domain:   cfg.CookieDomain,
        Path:     "/",
        MaxAge:   86400 * 7,
        HttpOnly: true,
        Secure:   cfg.CookieSecure,
        SameSite: http.SameSiteLaxMode,
    })

    // Trigger atlas-operator webhook for immediate instance provisioning
    go triggerAtlasOperatorRefresh(cfg)

    // Get redirect URL from state claims
    redirectTo := claims.RedirectTo
    if redirectTo == "" {
        redirectTo = "https://app.atlas.tempestdx.dev"
    }

    // Redirect to app
    // If instance not ready, Traefik will return 404 which triggers redirect to
    // https://auth.atlas.tempestdx.dev/provisioning via http-error-redirect middleware
    http.Redirect(w, r, redirectTo, http.StatusFound)
}
```

#### 6. OAuth State Protection

Bounce already implements OAuth CSRF protection using the OTP table:

```go
// services/bounce/service/oauth.go (existing code)
func (s *Service) GenerateOAuthState(redirectTo string) (string, error) {
    // Create OTP with 'oauthstate' use type
    otp := &repo.OTP{
        Code:      generateSecureToken(32),
        Use:       repo.BounceOTPUseOauthstate,
        ExpiresAt: time.Now().Add(10 * time.Minute),
    }

    if err := s.db.CreateOTP(otp); err != nil {
        return "", err
    }

    // Encode state with redirect URL
    claims := &OAuthStateClaims{
        RedirectTo: redirectTo,
        OTPCode:    otp.Code,
    }

    return s.encodeJWT(claims)
}

func (s *Service) ValidateOAuthState(state string) (*OAuthStateClaims, error) {
    // Decode JWT state
    claims, err := s.decodeJWT(state)
    if err != nil {
        return nil, fmt.Errorf("invalid state token: %w", err)
    }

    // Verify OTP hasn't been used
    otp, err := s.db.GetOTP(claims.OTPCode, repo.BounceOTPUseOauthstate)
    if err != nil {
        return nil, fmt.Errorf("invalid state: %w", err)
    }

    if otp.UsedAt != nil {
        return nil, fmt.Errorf("state already used")
    }

    if time.Now().After(otp.ExpiresAt) {
        return nil, fmt.Errorf("state expired")
    }

    // Mark as used
    now := time.Now()
    otp.UsedAt = &now
    s.db.UpdateOTP(otp)

    return claims, nil
}
```

#### 6. The extractuserid Middleware (FORKED TO ATLAS)

We need to fork the extractuserid middleware from tempest-core to Atlas and remove the hex conversion:

```go
// apps/atlas-traefik/middleware/extractuserid/extractuserid.go
// FORKED FROM tempest-core/applications/traefik/extractuserid
// MODIFIED: Removed hex conversion since we use base36 IDs

package extractuserid

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

// Config the plugin configuration.
type Config struct {
    CookieName   string `json:"cookieName,omitempty"`
    JWTPublicKey string `json:"jwtPublicKey,omitempty"`
    HeaderName   string `json:"headerName,omitempty"`
}

// CreateConfig creates the default plugin configuration.
func CreateConfig() *Config {
    return &Config{
        CookieName: "atlas_token",
        HeaderName: "X-Atlas-User-ID",
    }
}

// ExtractUserID plugin.
type ExtractUserID struct {
    next         http.Handler
    cookieName   string
    jwtPublicKey string
    headerName   string
    name         string
}

// LogEntry matches Traefik's access log format
type LogEntry struct {
    Time          string `json:"time"`
    Level         string `json:"level"`
    Msg           string `json:"msg"`
    UserID        string `json:"user_id,omitempty"`
    Error         string `json:"error,omitempty"`
    RequestMethod string `json:"RequestMethod,omitempty"`
    RequestPath   string `json:"RequestPath,omitempty"`
    RequestHost   string `json:"RequestHost,omitempty"`
    ClientAddr    string `json:"ClientAddr,omitempty"`
    StartLocal    string `json:"StartLocal,omitempty"`
    StartUTC      string `json:"StartUTC,omitempty"`
}

// New creates a new extractuserid plugin.
func New(ctx context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
    if len(config.CookieName) == 0 {
        return nil, fmt.Errorf("no cookie name configured")
    }

    if len(config.JWTPublicKey) == 0 {
        return nil, fmt.Errorf("no public key configured")
    }

    if len(config.HeaderName) == 0 {
        return nil, fmt.Errorf("no header name configured")
    }

    ret := &ExtractUserID{
        next:         next,
        cookieName:   config.CookieName,
        jwtPublicKey: config.JWTPublicKey,
        headerName:   config.HeaderName,
        name:         name,
    }

    return ret, nil
}

func (p *ExtractUserID) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
    // SECURITY: Delete any pre-existing header to prevent header injection attacks
    // This MUST be the first operation - remove the header before any validation
    req.Header.Del(p.headerName)

    // Extract JWT from cookie
    tokenString, ok := getJWT(req, p.cookieName)
    if !ok {
        // No JWT present - reject with 401 Unauthorized
        logError(req, "missing JWT cookie").print()
        http.Error(rw, "Unauthorized: Missing authentication token", http.StatusUnauthorized)
        return
    }

    // Read public key from file
    publicKeyPEM, err := readSecretFromFile(p.jwtPublicKey)
    if err != nil {
        logError(req, "error reading public key").withError(err).print()
        http.Error(rw, "Internal Server Error", http.StatusInternalServerError)
        return
    }

    // Verify JWT and extract claims
    token, err := verifyJWT(tokenString, publicKeyPEM)
    if err != nil {
        logError(req, "invalid JWT").withError(err).print()
        http.Error(rw, "Unauthorized: Invalid authentication token", http.StatusUnauthorized)
        return
    }

    if token == nil || !token.Valid {
        logError(req, "token not valid").print()
        http.Error(rw, "Unauthorized: Invalid authentication token", http.StatusUnauthorized)
        return
    }

    // Extract sub claim
    claims, ok := token.Claims.(jwt.MapClaims)
    if !ok {
        logError(req, "failed to extract claims").print()
        http.Error(rw, "Unauthorized: Invalid token claims", http.StatusUnauthorized)
        return
    }

    sub, ok := claims["sub"].(string)
    if !ok || sub == "" {
        logError(req, "missing sub claim").print()
        http.Error(rw, "Unauthorized: Invalid token claims", http.StatusUnauthorized)
        return
    }

    // ATLAS MODIFICATION: NO HEX CONVERSION!
    // Our base36 IDs (lowercase+digits) are safe for headers
    // Example: '6bd8e78lgpqzw' goes directly in the header
    req.Header.Set(p.headerName, sub)

    logInfo(req, "extracted user_id").withUserID(sub).print()

    // Pass to next handler
    p.next.ServeHTTP(rw, req)
}

func getJWT(req *http.Request, cookieName string) (string, bool) {
    // Extract JWT from cookie
    cookie, err := req.Cookie(cookieName)
    if err == nil && cookie != nil {
        return cookie.Value, true
    }
    return "", false
}

func verifyJWT(tokenString string, publicKeyPEM string) (*jwt.Token, error) {
    publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(publicKeyPEM))
    if err != nil {
        return nil, fmt.Errorf("failed to parse public key: %w", err)
    }

    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
        if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return publicKey, nil
    })
    if err != nil {
        return nil, err
    }
    return token, nil
}

func readSecretFromFile(filepath string) (string, error) {
    data, err := os.ReadFile(filepath)
    if err != nil {
        return "", err
    }
    return string(data), nil
}

// logInfo creates an info-level log entry with request context
func logInfo(req *http.Request, msg string) *LogEntry {
    now := time.Now()
    return &LogEntry{
        Time:          now.Format(time.RFC3339),
        Level:         "info",
        Msg:           msg,
        RequestMethod: req.Method,
        RequestPath:   req.URL.Path,
        RequestHost:   req.Host,
        ClientAddr:    req.RemoteAddr,
        StartLocal:    now.Format(time.RFC3339Nano),
        StartUTC:      now.UTC().Format(time.RFC3339Nano),
    }
}

// logError creates an error-level log entry with request context
func logError(req *http.Request, msg string) *LogEntry {
    now := time.Now()
    return &LogEntry{
        Time:          now.Format(time.RFC3339),
        Level:         "error",
        Msg:           msg,
        RequestMethod: req.Method,
        RequestPath:   req.URL.Path,
        RequestHost:   req.Host,
        ClientAddr:    req.RemoteAddr,
        StartLocal:    now.Format(time.RFC3339Nano),
        StartUTC:      now.UTC().Format(time.RFC3339Nano),
    }
}

func (e *LogEntry) withUserID(userID string) *LogEntry {
    e.UserID = userID
    return e
}

func (e *LogEntry) withError(err error) *LogEntry {
    if err != nil {
        e.Error = err.Error()
    }
    return e
}

func (e *LogEntry) print() {
    jsonBytes, _ := json.Marshal(e)
    fmt.Println(string(jsonBytes))
}
```

This modification means:
- User ID in database: `6bd8e78lgpqzw`
- User ID in JWT 'sub' claim: `6bd8e78lgpqzw`
- User ID in X-Atlas-User-ID header: `6bd8e78lgpqzw`
- User ID in IngressRoute match: `6bd8e78lgpqzw`

No conversions needed anywhere!

#### 7. Simplified IngressRoute Creation

With our base36 IDs, IngressRoutes become much cleaner:

```yaml
# Generated by atlas-operator for user with ID '6bd8e78lgpqzw'
# No hex conversion needed - use the ID directly!
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: atlas-6bd8e78lgpqzw
  namespace: atlas
spec:
  entryPoints:
    - websecure
  routes:
    # Match requests with the X-Atlas-User-ID header (same as JWT 'sub' claim)
    - match: Host(`app.atlas.tempestdx.dev`) && Header(`X-Atlas-User-ID`, `6bd8e78lgpqzw`)
      kind: Rule
      services:
        - name: atlas-6bd8e78lgpqzw
          port: 3000  # web-client
      middlewares: []

    # Route /api to daemon
    - match: Host(`app.atlas.tempestdx.dev`) && Header(`X-Atlas-User-ID`, `6bd8e78lgpqzw`) && PathPrefix(`/api`)
      kind: Rule
      services:
        - name: atlas-6bd8e78lgpqzw
          port: 8080  # daemon

    # Route /health to daemon
    - match: Host(`app.atlas.tempestdx.dev`) && Header(`X-Atlas-User-ID`, `6bd8e78lgpqzw`) && Path(`/health`)
      kind: Rule
      services:
        - name: atlas-6bd8e78lgpqzw
          port: 8080  # daemon
```

The entire flow with simplified IDs:
1. User logs in, gets JWT with 'sub': `6bd8e78lgpqzw`
2. extractuserid reads JWT, sets header: `X-Atlas-User-ID: 6bd8e78lgpqzw` (no conversion!)
3. Traefik matches IngressRoute with `Header(\`X-Atlas-User-ID\`, \`6bd8e78lgpqzw\`)`
4. Routes to service `atlas-6bd8e78lgpqzw`

#### 8. ForwardAuth Endpoint for Local Development

For local development, bounce needs a forwardauth endpoint that mimics extractuserid:

```go
// services/bounce/handlers/forwardauth.go
func handleForwardAuth(w http.ResponseWriter, r *http.Request) {
    // Get JWT from cookie
    cookie, err := r.Cookie("atlas_token")
    if err != nil {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    // Validate JWT
    token, err := jwt.Parse(cookie.Value, func(token *jwt.Token) (interface{}, error) {
        return publicKey, nil
    })
    if err != nil || !token.Valid {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    // Extract user ID from JWT
    claims, _ := token.Claims.(jwt.MapClaims)
    userID, _ := claims["sub"].(string)  // This is public.user.id (base36 shortid)

    // No conversion needed! Use the ID directly
    // Example: "6bd8e78lgpqzw" is already safe for headers
    w.Header().Set("X-Atlas-User-ID", userID)
    w.WriteHeader(http.StatusOK)
}
```

#### 7. Local Development Configuration

Environment-based configuration for different environments:

```go
// services/bounce/config/env.go
func LoadConfigWithEnvironment() (*Config, error) {
    var cfg Config
    if err := envconfig.Process("", &cfg); err != nil {
        return nil, err
    }

    // Auto-detect cookie domain if not set
    if cfg.CookieDomain == "" {
        if strings.Contains(cfg.RedirectURI, "localhost") {
            cfg.CookieDomain = "localhost"
        } else {
            cfg.CookieDomain = ".atlas.tempestdx.dev"
        }
    }

    return &cfg, nil
}
```

Environment files:
```bash
# .env.local
COOKIE_DOMAIN=localhost
REDIRECT_URI=http://localhost:1420
SIGNUP_HOSTNAME=http://localhost:8084
POSTGRES_CONNECTION=postgresql://postgres:postgres@localhost:5432/atlas?sslmode=disable
CORS_ALLOWED_ORIGINS=http://localhost:1420,http://localhost:8084

# .env.production
COOKIE_DOMAIN=.atlas.tempestdx.dev
REDIRECT_URI=https://app.atlas.tempestdx.dev
SIGNUP_HOSTNAME=https://auth.atlas.tempestdx.dev
POSTGRES_CONNECTION=postgresql://postgres:password@postgres:5432/atlas?sslmode=require
CORS_ALLOWED_ORIGINS=https://app.atlas.tempestdx.dev
```

#### 8. OTP Implementation

```go
// services/bounce/service/otp.go

package service

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "hash"
    "time"
)

const (
    otpStr    = "otp.email:%s;otp.epoch:%d"
    otpExpiry = time.Hour * 24
)

type OTP struct {
    Email     string
    CreatedAt time.Time
    hash      hash.Hash
    sum       []byte
}

func NewOTP(email, secret string, createTime time.Time) (*OTP, error) {
    if email == "" || secret == "" {
        return nil, errors.New("email and secret are required")
    }

    var t time.Time
    if createTime.IsZero() {
        t = time.Now()
    } else {
        t = createTime
    }

    o := &OTP{
        Email:     email,
        CreatedAt: t,
    }

    h := hmac.New(sha256.New, []byte(secret))
    _, err := fmt.Fprintf(h, otpStr, email, o.CreatedAt.Unix())
    if err != nil {
        return nil, err
    }

    o.hash = h
    o.sum = h.Sum(nil)
    return o, nil
}

func (o *OTP) String() string {
    return hex.EncodeToString(o.sum)
}

func (o *OTP) Verify(token string) (bool, error) {
    if o.sum == nil {
        return false, errors.New("OTP not initialized")
    }

    expected := hex.EncodeToString(o.sum)
    return hmac.Equal([]byte(expected), []byte(token)), nil
}
```

#### 9. Complete Signup Flow Implementation

```go
// services/bounce/handlers/signup.go (from tempest-core/applications/bounce/service/signup.go)

const SIGNUP_CONFIRMATION_SENDGRID_TEMPLATE_ID = "d-fe853da3d694420d82c4f12fb6f9bc4b" // Atlas SendGrid template

// POST /signup/email - Send confirmation email
func handleSignupEmail(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    log := httplog.LogEntry(ctx)

    var req struct {
        Email string `json:"email" validate:"required,email"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    // Remove domain checks for Atlas (no business email requirement)

    // Create confirmation token
    otp, err := NewOTP(req.Email, cfg.SignupHMACSecret, time.Now())
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    otpStr := otp.String()

    // Begin transaction
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    defer tx.Rollback()

    // Check if user already exists
    var existingUser bounce.AuthUser
    err = tx.QueryRowContext(ctx,
        `SELECT id, email, email_confirmed FROM bounce.auth_user WHERE email = $1`,
        req.Email).Scan(&existingUser.ID, &existingUser.Email, &existingUser.EmailConfirmed)

    if err == nil && existingUser.EmailConfirmed {
        http.Error(w, "User already exists", http.StatusConflict)
        return
    }

    // Save unconfirmed user or update confirmation token
    _, err = tx.ExecContext(ctx, `
        INSERT INTO bounce.auth_user (email, confirmation_token, confirmation_sent_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (email)
        DO UPDATE SET
            confirmation_token = EXCLUDED.confirmation_token,
            confirmation_sent_at = EXCLUDED.confirmation_sent_at
        WHERE auth_user.email_confirmed = false
    `, req.Email, otpStr, time.Now())

    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Send confirmation email
    confirmationLink := cfg.SignupHostname + "/signup/email/verify?t=" + otpStr

    sendgrid, err := newSendgridEmail(cfg, &SendgridEmailConfig{
        TemplateID: SIGNUP_CONFIRMATION_SENDGRID_TEMPLATE_ID,
        Data: map[string]interface{}{
            "signup_email":      req.Email,
            "confirmation_link": confirmationLink,
        },
        RecipientName:  req.Email,
        RecipientEmail: req.Email,
        SenderName:     "Atlas",
        SenderEmail:    "noreply@" + cfg.EmailDomain,
    })
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    if err = sendgrid.Send(); err != nil {
        log.Error("Could not send confirmation email", "error", err)
        // Still commit transaction - user can request resend
    }

    if err = tx.Commit(); err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Return success (don't redirect to check-email, show message inline)
    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{
        "message": "Confirmation email sent. Please check your inbox.",
    })
}

// GET /signup/email/verify?t={token} - Verify email and create user
func handleSignupVerify(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    log := httplog.LogEntry(ctx)

    token := r.URL.Query().Get("t")
    if token == "" {
        http.Error(w, "Missing token", http.StatusBadRequest)
        return
    }

    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    defer tx.Rollback()

    // Get auth user by confirmation token
    var authUser bounce.AuthUser
    err = tx.QueryRowContext(ctx,
        `SELECT id, email, confirmation_sent_at
         FROM bounce.auth_user
         WHERE confirmation_token = $1 AND email_confirmed = false`,
        token).Scan(&authUser.ID, &authUser.Email, &authUser.ConfirmationSentAt)

    if err != nil {
        http.Redirect(w, r, cfg.RedirectURI+"/signup-retry", http.StatusTemporaryRedirect)
        return
    }

    // Check token expiry (24 hours)
    if time.Since(authUser.ConfirmationSentAt) > 24*time.Hour {
        http.Redirect(w, r, cfg.RedirectURI+"/signup-retry", http.StatusTemporaryRedirect)
        return
    }

    // Verify HMAC token
    otp, err := NewOTP(authUser.Email, cfg.SignupHMACSecret, authUser.ConfirmationSentAt)
    if err != nil || otp.String() != token {
        http.Redirect(w, r, cfg.RedirectURI+"/signup-retry", http.StatusTemporaryRedirect)
        return
    }

    // Confirm the user
    _, err = tx.ExecContext(ctx,
        `UPDATE bounce.auth_user
         SET email_confirmed = true, email_confirmed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        authUser.ID)

    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Create user in public schema (with ON CONFLICT to handle existing users)
    // The returned ID will be a shortid (e.g., '6bd8e78lgpqzw') generated by _tempest.shortid()
    var userID string
    err = tx.QueryRowContext(ctx,
        `INSERT INTO public."user" (bounce_auth_user_id, email, full_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (bounce_auth_user_id) DO UPDATE SET
            email = EXCLUDED.email,
            updated_at = NOW()
         RETURNING id`,
        authUser.ID, authUser.Email, authUser.Email).Scan(&userID)

    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    if err = tx.Commit(); err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Create JWT
    // IMPORTANT: The 'sub' claim contains public.user.id (base36 shortid)
    // No hex conversion needed with our simplified IDs!
    token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
        "sub":   userID,  // public.user.id (shortid like '6bd8e78lgpqzw')
        "email": authUser.Email,
        "jti":   uuid.New().String(),
        "iat":   time.Now().Unix(),
        "exp":   time.Now().Add(24 * time.Hour).Unix(),
        "aud":   []string{"atlas"},
        "amr":   []map[string]interface{}{{"method": "email"}},
    })

    privateKey, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(cfg.JWTPrivateKey))
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    tokenString, err := token.SignedString(privateKey)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Set JWT cookie
    http.SetCookie(w, &http.Cookie{
        Name:     cfg.CookieName,
        Value:    tokenString,
        Domain:   cfg.CookieDomain,
        Path:     "/",
        MaxAge:   86400 * 7,
        HttpOnly: true,
        Secure:   !strings.HasSuffix(cfg.CookieDomain, "localhost"),
        SameSite: http.SameSiteLaxMode,
    })

    // Redirect to complete setup
    http.Redirect(w, r, cfg.RedirectURI+"/complete-setup", http.StatusTemporaryRedirect)
}

// Email sending helper (from tempest-core/applications/bounce/service/email.go)
type SendgridEmailConfig struct {
    TemplateID     string
    Data           map[string]interface{}
    RecipientName  string
    RecipientEmail string
    SenderName     string
    SenderEmail    string
}

func newSendgridEmail(cfg Config, opts *SendgridEmailConfig) (*SendgridEmailConfig, error) {
    if cfg.SendgridAPIKey == "" {
        return nil, errors.New("sendgrid api key required")
    }
    // ... validation ...
    return opts, nil
}

func (s *SendgridEmailConfig) Send() error {
    from := mail.NewEmail(s.SenderName, s.SenderEmail)
    to := mail.NewEmail(s.RecipientName, s.RecipientEmail)

    m := mail.NewV3Mail()
    m.SetFrom(from)
    m.SetTemplateID(s.TemplateID)

    p := mail.NewPersonalization()
    p.AddTos(to)
    for k, v := range s.Data {
        p.SetDynamicTemplateData(k, v)
    }
    m.AddPersonalizations(p)

    client := sendgrid.NewSendClient(cfg.SendgridAPIKey)
    _, err := client.Send(m)
    return err
}
```

#### 9. Magic Link Implementation

The magic link flow (ported from tempest-core):

```go
// services/bounce/handlers/magiclink.go

func handleLoginEmail(w http.ResponseWriter, r *http.Request) {
    var req struct {
        Email string `json:"email"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    // Check if user exists
    user, err := db.GetUserByEmail(req.Email)
    if err != nil {
        // Still return 200 to prevent email enumeration
        w.WriteHeader(http.StatusOK)
        return
    }

    // Generate OTP token
    otp := generateSecureToken(32)
    expiresAt := time.Now().Add(15 * time.Minute)

    // Store OTP in database
    err = db.CreateOTP(&OTP{
        Code:      otp,
        Use:       "magiclink",
        AuthUserID: user.ID,
        ExpiresAt: expiresAt,
    })
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Send magic link email
    magicLinkURL := fmt.Sprintf("%s/magiclink?otp=%s", cfg.AppURL, otp)
    err = sendEmail(user.Email, "Sign in to Atlas", magicLinkEmailTemplate, map[string]interface{}{
        "login_link": magicLinkURL,
        "email": user.Email,
    })
    if err != nil {
        log.Printf("Failed to send email: %v", err)
        // Still return OK
    }

    w.WriteHeader(http.StatusOK)
}

func handleMagicLink(w http.ResponseWriter, r *http.Request) {
    otp := r.URL.Query().Get("otp")
    if otp == "" {
        http.Error(w, "Missing token", http.StatusBadRequest)
        return
    }

    // Validate and use OTP
    otpRecord, err := db.UseOTP(otp, "magiclink")
    if err != nil {
        http.Redirect(w, r, "/login?error=invalid_link", http.StatusFound)
        return
    }

    // Check expiry
    if time.Now().After(otpRecord.ExpiresAt) {
        http.Redirect(w, r, "/login?error=expired_link", http.StatusFound)
        return
    }

    // Get Atlas user by auth user ID
    var user struct {
        ID    string  // public.user.id (shortid)
        Email string
        AuthUserID string  // bounce.auth_user.id
    }
    err = db.QueryRowContext(ctx,
        `SELECT u.id, u.email, u.bounce_auth_user_id
         FROM public."user" u
         WHERE u.bounce_auth_user_id = $1`,
        otpRecord.AuthUserID).Scan(&user.ID, &user.Email, &user.AuthUserID)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Create JWT
    // IMPORTANT: 'sub' contains public.user.id (base36 shortid)
    token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
        "sub": user.ID,  // public.user.id (shortid like '6bd8e78lgpqzw')
        "email": user.Email,
        "iat": time.Now().Unix(),
        "exp": time.Now().Add(24 * time.Hour).Unix(),
        "aud": []string{"atlas"},
        "amr": []map[string]interface{}{{"method": "magiclink"}},
    })

    tokenString, err := token.SignedString(privateKey)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Set JWT cookie
    http.SetCookie(w, &http.Cookie{
        Name:     "atlas_token",
        Value:    tokenString,
        Domain:   cfg.CookieDomain,
        Path:     "/",
        MaxAge:   86400 * 7,
        HttpOnly: true,
        Secure:   cfg.CookieSecure,
        SameSite: http.SameSiteLaxMode,
    })

    // Trigger atlas-operator webhook
    go triggerAtlasOperatorRefresh(cfg)

    // Redirect to app
    http.Redirect(w, r, cfg.AppURL, http.StatusFound)
}
```

#### 10. Complete OAuth Implementation

```go
// services/bounce/handlers/oauth.go (from tempest-core/applications/bounce/service/oauth.go)

// GET /oauth/google/authorize - Redirect to Google OAuth
func handleOAuthAuthorize(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    log := httplog.LogEntry(ctx)

    redirectTo := r.URL.Query().Get("redirect_to")
    if redirectTo == "" {
        redirectTo = cfg.RedirectURI
    }

    // Generate state token using JWT
    requestID := uuid.New().String()
    claims := oauthStateClaims{
        RegisteredClaims: jwt.RegisteredClaims{
            Issuer:    cfg.BounceServiceURL,
            Subject:   requestID,
            Audience:  jwt.ClaimStrings{cfg.BounceServiceURL},
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(5 * time.Minute)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
        },
        Provider:        "google",
        RedirectTo:      redirectTo,
        ScopesRequested: []string{"openid", "email", "profile"},
    }

    privateKey, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(cfg.JWTPrivateKey))
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    stateToken, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(privateKey)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Parse Google OAuth credentials using google's helper
    oauthConfig, err := google.ConfigFromJSON([]byte(cfg.OAuthGoogleCredentialJSON))
    if err != nil {
        log.Error("Failed to parse Google OAuth config", "error", err)
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    oauthConfig.RedirectURL = cfg.BounceServiceURL + "/oauth/google/callback"
    oauthConfig.Scopes = []string{"openid", "email", "profile"}

    // Redirect to Google
    url := oauthConfig.AuthCodeURL(stateToken, oauth2.AccessTypeOffline, oauth2.ApprovalForce)
    http.Redirect(w, r, url, http.StatusFound)
}

// GET /oauth/google/callback - Handle OAuth callback
func handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    log := httplog.LogEntry(ctx)

    code := r.URL.Query().Get("code")
    state := r.URL.Query().Get("state")

    if code == "" || state == "" {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    // Validate state token
    var claims oauthStateClaims
    token, err := jwt.ParseWithClaims(state, &claims, func(token *jwt.Token) (interface{}, error) {
        publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(cfg.JWTPublicKey))
        if err != nil {
            return nil, err
        }
        return publicKey, nil
    })

    if err != nil || !token.Valid {
        http.Error(w, "Invalid state", http.StatusBadRequest)
        return
    }

    // Parse Google OAuth config
    oauthConfig, err := google.ConfigFromJSON([]byte(cfg.OAuthGoogleCredentialJSON))
    if err != nil {
        log.Error("Failed to parse Google OAuth config", "error", err)
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    oauthConfig.RedirectURL = cfg.BounceServiceURL + "/oauth/google/callback"
    oauthConfig.Scopes = []string{"openid", "email", "profile"}

    token, err := oauthConfig.Exchange(ctx, code)
    if err != nil {
        http.Error(w, "OAuth exchange failed", http.StatusBadRequest)
        return
    }

    // Get user info from Google
    resp, err := http.Get("https://www.googleapis.com/oauth2/v2/userinfo?access_token=" + token.AccessToken)
    if err != nil {
        http.Error(w, "Failed to get user info", http.StatusInternalServerError)
        return
    }
    defer resp.Body.Close()

    var googleUser struct {
        ID            string `json:"id"`
        Email         string `json:"email"`
        VerifiedEmail bool   `json:"verified_email"`
        Name          string `json:"name"`
        Picture       string `json:"picture"`
    }

    if err := json.NewDecoder(resp.Body).Decode(&googleUser); err != nil {
        http.Error(w, "Failed to decode user info", http.StatusInternalServerError)
        return
    }

    // Create or get user (simplified without orgs)
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    defer tx.Rollback()

    // Create or update bounce.auth_user
    var authUserID string
    err = tx.QueryRowContext(ctx, `
        INSERT INTO bounce.auth_user (email, email_confirmed, email_confirmed_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (email) DO UPDATE SET
            last_sign_in_at = NOW(),
            updated_at = NOW()
        RETURNING id`,
        googleUser.Email, googleUser.VerifiedEmail).Scan(&authUserID)

    if err != nil {
        http.Error(w, "Failed to create auth user", http.StatusInternalServerError)
        return
    }

    // Create or update bounce.identity
    _, err = tx.ExecContext(ctx, `
        INSERT INTO bounce.identity (auth_user_id, email, provider, provider_id, provider_user_data)
        VALUES ($1, $2, 'google', $3, $4)
        ON CONFLICT (provider, provider_id, email) DO UPDATE SET
            last_sign_in_at = NOW(),
            provider_user_data = EXCLUDED.provider_user_data,
            updated_at = NOW()`,
        authUserID, googleUser.Email, googleUser.ID,
        map[string]interface{}{
            "name":    googleUser.Name,
            "picture": googleUser.Picture,
        })

    if err != nil {
        http.Error(w, "Failed to create identity", http.StatusInternalServerError)
        return
    }

    // Create or update public.user
    var atlasUserID string
    err = tx.QueryRowContext(ctx, `
        INSERT INTO public."user" (bounce_auth_user_id, email, full_name, profile_photo)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (bounce_auth_user_id) DO UPDATE SET
            full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), public."user".full_name),
            profile_photo = COALESCE(NULLIF(EXCLUDED.profile_photo, ''), public."user".profile_photo),
            updated_at = NOW()
        RETURNING id`,
        authUserID, googleUser.Email, googleUser.Name, googleUser.Picture).Scan(&atlasUserID)

    if err != nil {
        http.Error(w, "Failed to create user", http.StatusInternalServerError)
        return
    }

    if err = tx.Commit(); err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Create JWT
    // IMPORTANT: 'sub' contains public.user.id (base36 shortid)
    jwtToken := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
        "sub":   atlasUserID,  // public.user.id (shortid like '6bd8e78lgpqzw')
        "email": googleUser.Email,
        "jti":   uuid.New().String(),
        "iat":   time.Now().Unix(),
        "exp":   time.Now().Add(24 * time.Hour).Unix(),
        "aud":   []string{"atlas"},
        "amr":   []map[string]interface{}{{"method": "oauth", "provider": "google"}},
    })

    privateKey, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(cfg.JWTPrivateKey))
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    tokenString, err := jwtToken.SignedString(privateKey)
    if err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    // Set JWT cookie
    http.SetCookie(w, &http.Cookie{
        Name:     cfg.CookieName,
        Value:    tokenString,
        Domain:   cfg.CookieDomain,
        Path:     "/",
        MaxAge:   86400 * 7,
        HttpOnly: true,
        Secure:   !strings.HasSuffix(cfg.CookieDomain, "localhost"),
        SameSite: http.SameSiteLaxMode,
    })

    // Trigger instance creation
    go triggerAtlasOperatorRefresh(cfg)

    // Redirect to app
    http.Redirect(w, r, claims.RedirectTo, http.StatusFound)
}
```

#### 11. Health Endpoint and Routes

```go
// services/bounce/main.go
func main() {
    r := chi.NewRouter()

    // Middleware
    r.Use(middleware.RealIP)
    r.Use(httplog.RequestLogger(logger))
    r.Use(cors.Handler(cors.Options{
        AllowedOrigins:   strings.Split(cfg.CORSAllowedOrigins, ","),
        AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
        AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
        AllowCredentials: true,
        MaxAge:           300,
    }))

    // Authentication routes
    r.Post("/signup/email", handleSignupEmail)
    r.Get("/signup/email/verify", handleSignupVerify)
    r.Post("/signup/complete", handleSignupComplete)

    // Login routes
    r.Post("/login/email", handleLoginEmail)  // Send magic link
    r.Get("/magiclink", handleMagicLink)      // Validate magic link token

    // OAuth routes
    r.Get("/oauth/google/authorize", handleOAuthAuthorize)
    r.Get("/oauth/google/callback", handleOAuthCallback)

    // Session management
    r.Get("/forwardauth", handleForwardAuth)  // For local dev Traefik
    r.Get("/logout", handleLogout)

    // Health endpoint - returns JSON for provisioning page compatibility
    // NOTE: Atlas daemon also needs to expose /health with CORS for provisioning checks
    r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]interface{}{
            "status": "healthy",
            "timestamp": time.Now().Format(time.RFC3339),
            "version": "1.0.0",
            "service": "bounce",
        })
    })

    http.ListenAndServe(":"+cfg.Port, r)
}

#### 9. Logout Implementation

```go
// services/bounce/handlers/logout.go

func handleLogout(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    log := httplog.LogEntry(ctx)

    // Get JWT from cookie for audit logging
    cookie, err := r.Cookie(cfg.CookieName)
    if err == nil && cookie.Value != "" {
        // Parse JWT to extract user ID for logging
        token, err := jwt.Parse(cookie.Value, func(token *jwt.Token) (interface{}, error) {
            publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(cfg.JWTPublicKey))
            if err != nil {
                return nil, err
            }
            return publicKey, nil
        })

        if err == nil && token.Valid {
            if claims, ok := token.Claims.(jwt.MapClaims); ok {
                // Audit log the logout
                if userID, exists := claims["sub"].(string); exists {
                    log.Info("User logged out", "user_id", userID, "email", claims["email"])
                }
            }
        }
    }

    // Clear the JWT cookie
    http.SetCookie(w, &http.Cookie{
        Name:     cfg.CookieName,
        Value:    "",
        Domain:   cfg.CookieDomain,
        Path:     "/",
        MaxAge:   -1,  // Delete cookie immediately
        HttpOnly: true,
        Secure:   !strings.HasSuffix(cfg.CookieDomain, "localhost"),
        SameSite: http.SameSiteLaxMode,
    })

    // Redirect to login page or custom redirect
    redirectURL := cfg.RedirectURI + "/login"
    if redirect := r.URL.Query().Get("redirect"); redirect != "" {
        redirectURL = redirect
    }

    http.Redirect(w, r, redirectURL, http.StatusFound)
}
```

#### 10. CORS Configuration

For the provisioning page to check health status across domains, Atlas daemon needs CORS headers for the `/health` endpoint:

```typescript
// apps/atlasd/routes/health.ts
// This file already exists and needs CORS headers added

import { daemonFactory } from "../src/factory.ts";

const healthRoutes = daemonFactory.createApp().get("/", (c) => {
  const ctx = c.get("app");

  // Add CORS headers for provisioning page
  const origin = c.req.header("Origin");
  if (origin === "https://auth.atlas.tempestdx.dev" ||
      origin === "https://app.atlas.tempestdx.dev" ||
      origin?.includes("localhost")) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Accept, Content-Type, Cookie");
  }

  return c.json({
    activeWorkspaces: ctx.runtimes.size,
    uptime: Date.now() - ctx.startTime,
    timestamp: new Date().toISOString(),
    version: { deno: Deno.version.deno, v8: Deno.version.v8, typescript: Deno.version.typescript },
  });
});

export { healthRoutes };
```

## 5. Integration with Atlas

### Direct Routing via Traefik

The auth service will be exposed directly via Traefik ingress, no proxy needed:

**Domains**:
- Development: `auth.atlas.tempestdx.dev`
- Production: `auth.atlas.tempestdx.com`

```yaml
# k8s/auth-ingressroute.yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: auth.atlas.tempestdx.dev
  namespace: atlas-operator
spec:
  entryPoints:
    - websecure
  routes:
    # Route API calls to bounce service
    - kind: Rule
      match: |
        Host(`auth.atlas.tempestdx.dev`) && (
          PathPrefix(`/login/email`) ||
          PathPrefix(`/signup/email`) ||
          PathPrefix(`/signup/complete`) ||
          PathPrefix(`/signup/validate`) ||
          PathPrefix(`/magiclink`) ||
          PathPrefix(`/oauth/google/authorize`) ||
          PathPrefix(`/oauth/google/callback`) ||
          PathPrefix(`/logout`) ||
          PathPrefix(`/health`)
        )
      services:
        - name: atlas-bounce
          port: 8083
          scheme: https
          serversTransport: internal-transport
    # Route static pages to auth UI service
    - kind: Rule
      match: |
        Host(`auth.atlas.tempestdx.dev`) && !PathPrefix(`/login/email`) && !PathPrefix(`/signup/email`) && !PathPrefix(`/magiclink`) && !PathPrefix(`/oauth`)
      priority: 10
      services:
        - name: atlas-auth-ui
          port: 80
          scheme: http
  tls:
    secretName: auth-atlas-tempestdx-dev
```

### Authentication via Traefik

JWT verification is handled by the existing Traefik setup in atlas-traefik. The auth service only needs to:
1. Issue JWTs with the correct format
2. Set cookies with the right domain (`.atlas.tempestdx.dev`)
3. Provide a `/sessioncheck` endpoint for session validation

No changes needed to the existing Traefik middleware configuration - it will work with the new auth service as long as we use the same JWT format and cookie name (`atlas_token`).

### Handling Atlas Instance Provisioning Delay

After successful authentication, there's a delay while the Atlas operator creates the user's instance. We need to handle this gracefully:

#### Provisioning Flow

1. **After Successful Login/Signup**:
   - Bounce service creates user, sets JWT cookie
   - Redirects to `app.atlas.tempestdx.dev`

2. **Instance Not Ready Yet**:
   - Traefik's `atlas-router` checks if user's instance exists
   - If not found (404), redirects to `/provisioning`

3. **Provisioning Page** (`atlas-auth-ui/src/provisioning.html`):
   ```html
   <!DOCTYPE html>
   <html>
   <head>
     <title>Setting up your Atlas workspace...</title>
     <link rel="stylesheet" href="/styles.css">
   </head>
   <body>
     <div class="provisioning-container">
       <h1>Setting up your Atlas workspace...</h1>
       <div class="spinner"></div>
       <p>This usually takes 30-60 seconds</p>
       <p class="status">Checking status...</p>
     </div>

     <script>
       let retryCount = 0;
       const maxRetries = 40;  // 40 * 3 seconds = 2 minutes

       // Poll for instance availability
       const APP_URL = window.location.hostname === 'localhost'
         ? 'http://localhost:1420'
         : 'https://app.atlas.tempestdx.dev';

       async function checkInstance() {
         try {
           // Check the app domain's health endpoint
           // Cookie domain is .atlas.tempestdx.dev so it works across subdomains
           // The cookie will be sent, extractuserid will set X-Atlas-User-ID,
           // and if the IngressRoute exists, we'll get routed to the instance
           const response = await fetch(`${APP_URL}/health`, {
             credentials: 'include',
             headers: {
               'Accept': 'application/json'
             }
           });

           if (response.ok) {
             const data = await response.json();
             // Instance is ready if we get a valid health response
             if (data.version && data.timestamp) {
               document.querySelector('.status').textContent = 'Workspace ready! Redirecting...';
               setTimeout(() => {
                 window.location.href = APP_URL;
               }, 500);
               return;
             }
           } else if (response.status === 404 || response.status === 502) {
             // Instance not yet created or not ready
             document.querySelector('.status').textContent = 'Creating your workspace...';
           }
         } catch (err) {
           // Network error, instance might not be ready
           console.log('Instance check failed:', err);
           document.querySelector('.status').textContent = 'Setting up your workspace...';
         }

         retryCount++;
         if (retryCount >= maxRetries) {
           // Try redirecting anyway after 2 minutes
           window.location.href = APP_URL;
         } else {
           // Check again in 3 seconds
           setTimeout(checkInstance, 3000);
         }
       }

       // Start checking immediately
       checkInstance();
     </script>
   </body>
   </html>
   ```

4. **Atlas Router Logic**:
   The Traefik router (or a custom middleware) needs to handle instance lookup:
   ```go
   // In Traefik custom plugin or middleware
   func routeToAtlasInstance(w http.ResponseWriter, r *http.Request) {
     userID := r.Header.Get("X-Atlas-User-ID")

     // Convert user ID to Atlas instance name format
     instanceName := fmt.Sprintf("atlas-%s", hashUserID(userID))

     // Check if service exists in Kubernetes
     service, err := k8sClient.CoreV1().Services("atlas").Get(
       context.Background(),
       instanceName,
       metav1.GetOptions{},
     )

     if err != nil || service == nil {
       // Instance not ready, redirect to provisioning page
       http.Redirect(w, r, "/provisioning", http.StatusTemporaryRedirect)
       return
     }

     // Route to user's instance
     target := fmt.Sprintf("http://%s.atlas.svc.cluster.local:8080", instanceName)
     proxy := httputil.NewSingleHostReverseProxy(parseURL(target))
     proxy.ServeHTTP(w, r)
   }
   ```

5. **Using Existing Health Endpoint**:
   The provisioning page uses the existing `/health` endpoint to check if the instance is ready:
   - Returns 200 with JSON when instance is up
   - Returns 404/502 when instance doesn't exist or isn't ready
   - No need for a custom instance-status endpoint

### IngressRoute Namespace Architecture

**Namespace Layout:**
- `atlas-operator` namespace: Infrastructure services
  - bounce service (auth backend)
  - atlas-auth-ui (static auth pages)
  - atlas-operator (instance manager)
  - Parent IngressRoute for app.atlas.tempestdx.dev
  - extractuserid middleware

- `atlas` namespace: User instances
  - Per-user pods (atlas-{userID})
  - Per-user Services
  - Per-user IngressRoutes

**Cross-namespace routing:** Traefik supports IngressRoutes across namespaces. The parent IngressRoute in `atlas-operator` namespace applies the extractuserid middleware, then Traefik finds matching child IngressRoutes in the `atlas` namespace based on the X-Atlas-User-ID header.

### Authentication Routing Strategy

#### How Users Get to Login Page

**Hosted Version (app.atlas.tempestdx.dev):**

1. **Traefik-Handled Redirect Flow** (following Tempest's pattern):
   - User visits `app.atlas.tempestdx.dev` without valid JWT
   - Traefik middleware chain:
     a. `checkjwt` middleware validates JWT cookie → returns 401 if invalid/missing
     b. `http-error-redirect` middleware catches 401 → redirects to `/login` with 302
   - User is automatically redirected to login page by Traefik

2. **Required Traefik Middleware**:
   ```yaml
   # Middleware to redirect unauthenticated users to login
   ---
   apiVersion: traefik.io/v1alpha1
   kind: Middleware
   metadata:
     name: atlas-auth-redirect
     namespace: atlas-operator
   spec:
     plugin:
       redirectErrors:
         status:
           - "401"
         target: "/login"
         outputStatus: 302
   ---
   # Middleware to redirect authenticated users without instances to provisioning
   apiVersion: traefik.io/v1alpha1
   kind: Middleware
   metadata:
     name: atlas-provisioning-redirect
     namespace: atlas-operator
   spec:
     plugin:
       redirectErrors:
         status:
           - "404"
         target: "https://auth.atlas.tempestdx.dev/provisioning"
         outputStatus: 302
         # Only redirect if user is authenticated (has X-Atlas-User-ID header)
         requireHeader: "X-Atlas-User-ID"
   ```

3. **IngressRoute Configuration**:
   ```yaml
   # Parent IngressRoute for app.atlas.tempestdx.dev
   ---
   apiVersion: traefik.io/v1alpha1
   kind: IngressRoute
   metadata:
     name: atlas-parent
     namespace: atlas-operator
   spec:
     entryPoints:
       - websecure
     tls:
       secretName: app-atlas-tempestdx-dev
     routes:
       # Public auth routes (no auth required)
       - match: Host(`app.atlas.tempestdx.dev`) && (PathPrefix(`/login`) || PathPrefix(`/signup`) || PathPrefix(`/verify`) || PathPrefix(`/complete-setup`))
         kind: Rule
         priority: 200  # Higher priority
         services:
           - name: atlas-auth-ui
             namespace: atlas-operator
             port: 80

       # Provisioning page (requires JWT but served by auth-ui)
       - match: Host(`app.atlas.tempestdx.dev`) && PathPrefix(`/provisioning`)
         kind: Rule
         priority: 190
         middlewares:
           - name: atlas-extract-userid
             namespace: atlas-operator
           - name: atlas-auth-redirect  # Redirect to login if no JWT
             namespace: atlas-operator
         services:
           - name: atlas-auth-ui
             namespace: atlas-operator
             port: 80

       # All other routes (require auth, delegate to child IngressRoutes)
       - match: Host(`app.atlas.tempestdx.dev`)
         kind: Rule
         priority: 100
         middlewares:
           - name: atlas-extract-userid  # Validates JWT, sets X-Atlas-User-ID
             namespace: atlas-operator
           - name: atlas-auth-redirect  # Redirects 401 to /login
             namespace: atlas-operator
           - name: atlas-provisioning-redirect  # Redirects 404 to /provisioning if authenticated
             namespace: atlas-operator

   # IngressRoute for auth.atlas.tempestdx.dev (bounce service)
   ---
   apiVersion: traefik.io/v1alpha1
   kind: IngressRoute
   metadata:
     name: atlas-auth
     namespace: atlas-operator
   spec:
     entryPoints:
       - websecure
     tls:
       secretName: auth-atlas-tempestdx-dev
     routes:
       - match: Host(`auth.atlas.tempestdx.dev`)
         kind: Rule
         services:
           - name: atlas-bounce
             namespace: atlas-operator
             port: 8083
   ```

4. **Route Configuration**:
   - `app.atlas.tempestdx.dev/api/*` → Atlas daemon:8080 (user's instance)
   - `app.atlas.tempestdx.dev/health` → Atlas daemon:8080 (user's instance)
   - `app.atlas.tempestdx.dev/streams/*` → Atlas daemon:8080 (user's instance)
   - `app.atlas.tempestdx.dev/login` → atlas-auth-ui (no JWT required)
   - `app.atlas.tempestdx.dev/signup` → atlas-auth-ui (no JWT required)
   - `app.atlas.tempestdx.dev/*` → web-client:3000 (user's instance, JWT required)
   - `auth.atlas.tempestdx.dev/*` → bounce service (for authentication API)

**Tauri/Standalone Version:**
- No auth checks or redirects
- Auth pages exist in build but aren't linked
- Users can't navigate to `/login` or `/signup`
- Direct access to all app functionality

#### Auth Pages Architecture

**Critical Insight**: Atlas instances are per-user and created AFTER authentication. Therefore, login/signup pages cannot be served from the web-client within Atlas instances. We need a **separate, always-available deployment** for auth pages.

**Solution: Atlas Auth UI Service**

Create a new lightweight service in `atlas-operator` namespace to serve auth pages:

```
apps/
├── atlas-auth-ui/             # NEW - Always-available auth pages
│   ├── Dockerfile
│   ├── nginx.conf
│   └── static/
│       ├── login.html
│       ├── signup.html
│       ├── verify.html
│       └── complete-setup.html
└── web-client/                # Existing - Per-user Atlas UI
    └── src/routes/
        └── (app)/             # Protected app routes only
```

The auth UI will be a simple static site deployed as:
- Service: `atlas-auth-ui` in `atlas-operator` namespace
- Always running, not per-user
- Handles authentication flow, then redirects to user's Atlas instance
- Provides a "provisioning" page while Atlas instance is being created

#### atlas-auth-ui Implementation

**Dockerfile:**
```dockerfile
# apps/atlas-auth-ui/Dockerfile
FROM nginx:alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY static/ /usr/share/nginx/html/
EXPOSE 80
```

**nginx.conf:**
```nginx
# apps/atlas-auth-ui/nginx.conf
events {
    worker_connections 1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    server {
        listen 80;
        server_name _;

        root /usr/share/nginx/html;
        index index.html;

        # Security headers
        add_header X-Frame-Options "DENY";
        add_header X-Content-Type-Options "nosniff";
        add_header X-XSS-Protection "1; mode=block";

        # Cache static assets
        location ~* \.(css|js|png|jpg|jpeg|gif|ico)$ {
            expires 1h;
            add_header Cache-Control "public, immutable";
        }

        # Auth pages
        location / {
            try_files $uri $uri/ /index.html;
        }
    }
}
```

**Kubernetes Deployment:**
```yaml
# k8s/atlas-auth-ui-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atlas-auth-ui
  namespace: atlas-operator
spec:
  replicas: 2
  selector:
    matchLabels:
      app: atlas-auth-ui
  template:
    metadata:
      labels:
        app: atlas-auth-ui
    spec:
      containers:
      - name: nginx
        image: gcr.io/atlas-prod/atlas-auth-ui:latest
        ports:
        - containerPort: 80
        resources:
          requests:
            memory: "32Mi"
            cpu: "10m"
          limits:
            memory: "64Mi"
            cpu: "50m"
---
apiVersion: v1
kind: Service
metadata:
  name: atlas-auth-ui
  namespace: atlas-operator
spec:
  selector:
    app: atlas-auth-ui
  ports:
  - port: 80
    targetPort: 80
```

**Sample HTML Pages:**
```html
<!-- apps/atlas-auth-ui/static/login.html -->
<!DOCTYPE html>
<html>
<head>
    <title>Atlas - Login</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .auth-container { max-width: 400px; padding: 2rem; }
        .form-group { margin-bottom: 1rem; }
        input { width: 100%; padding: 0.5rem; font-size: 1rem; }
        button { width: 100%; padding: 0.75rem; font-size: 1rem; background: #0066cc; color: white; border: none; cursor: pointer; }
        .divider { text-align: center; margin: 1.5rem 0; }
    </style>
</head>
<body>
    <div class="auth-container">
        <h2>Login to Atlas</h2>
        <div class="form-group">
            <input type="email" id="email" placeholder="Email address" required>
        </div>
        <button onclick="sendMagicLink()">Send Magic Link</button>

        <div class="divider">or</div>

        <button onclick="loginWithGoogle()">Login with Google</button>

        <script>
            const AUTH_API = 'https://auth.atlas.tempestdx.dev';

            async function sendMagicLink() {
                const email = document.getElementById('email').value;
                const response = await fetch(`${AUTH_API}/login/email`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({email})
                });
                if (response.ok) {
                    alert('Check your email for the magic link!');
                }
            }

            function loginWithGoogle() {
                window.location.href = `${AUTH_API}/oauth/google/authorize`;
            }
        </script>
    </div>
</body>
</html>

<!-- apps/atlas-auth-ui/static/provisioning.html -->
<!DOCTYPE html>
<html>
<head>
    <title>Atlas - Setting up your workspace</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #0066cc; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div style="text-align: center;">
        <div class="spinner"></div>
        <h2>Setting up your Atlas workspace...</h2>
        <p>This usually takes 30-60 seconds</p>
        <script>
            const APP_URL = 'https://app.atlas.tempestdx.dev';

            async function checkInstance() {
                try {
                    const response = await fetch(`${APP_URL}/health`, {
                        credentials: 'include',
                        mode: 'cors'
                    });
                    if (response.ok) {
                        window.location.href = APP_URL;
                    }
                } catch (e) {
                    // Instance not ready yet
                }
            }

            // Check every 2 seconds
            setInterval(checkInstance, 2000);

            // Initial check
            checkInstance();
        </script>
    </div>
</body>
</html>
```

### Client-Side Integration

The web client will make auth requests directly to the auth subdomain:

```typescript
// apps/web-client/src/lib/auth.ts
const AUTH_URL = import.meta.env.ATLAS_AUTH_URL || "https://auth.atlas.tempestdx.dev";

export async function signup(email: string) {
  const response = await fetch(`${AUTH_URL}/signup/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
    credentials: "include", // Important for cookies
  });
  return response.json();
}

export async function verifyEmail(token: string) {
  // This will redirect and set cookie
  window.location.href = `${AUTH_URL}/signup/email/verify?t=${token}`;
}

export async function logout() {
  await fetch(`${AUTH_URL}/logout`, {
    method: "POST",
    credentials: "include",
  });
  window.location.href = "/login";
}
```

Environment variables set during build:
```bash
# .env.development
ATLAS_AUTH_URL=https://auth.atlas.tempestdx.dev

# .env.production
ATLAS_AUTH_URL=https://auth.atlas.tempestdx.com
```

### Cookie Configuration for Cross-Subdomain

The auth service sets cookies that work across subdomains:

```go
// apps/bounce/handlers/session.go
func setAuthCookie(w http.ResponseWriter, token string) {
    cookie := &http.Cookie{
        Name:     "atlas_token",
        Value:    token,
        Domain:   ".atlas.tempestdx.dev",  // Works for all *.atlas.tempestdx.dev subdomains
        Path:     "/",
        MaxAge:   604800,                   // 7 days
        HttpOnly: true,                     // Not accessible via JavaScript
        Secure:   true,                     // HTTPS only (except localhost)
        SameSite: http.SameSiteLaxMode,
    }
    http.SetCookie(w, cookie)
}
```

This allows the cookie to be shared between Atlas subdomains only:
- `auth.atlas.tempestdx.dev` (auth service)
- `app.atlas.tempestdx.dev` (Atlas web UI and API at /api/*)
- But NOT with `app.tempestdx.dev` (Tempest app)

## 6. CI/CD Integration

### GitHub Actions Workflow

```yaml
# .github/workflows/go.yml
name: Go CI

on:
  push:
    paths:
      - 'apps/bounce/**/*.go'
      - 'go.mod'
      - 'go.sum'
      - '.github/workflows/go.yml'
  pull_request:
    paths:
      - 'apps/bounce/**/*.go'
      - 'go.mod'
      - 'go.sum'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Set up Go
        uses: actions/setup-go@v6
        with:
          go-version-file: 'go.mod'

      - name: Download dependencies
        run: go mod download

      - name: Run tests
        run: go test -v -race ./apps/bounce/...

      - name: Check sqlc generation
        run: |
          make generate-bounce
          git diff --exit-code

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: golangci-lint
        uses: golangci/golangci-lint-action@v9
        with:
          version: latest
          args: ./apps/bounce/...

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - name: Set up Go
        uses: actions/setup-go@v6
        with:
          go-version-file: 'go.mod'

      - name: Build bounce service
        run: make build-bounce

      - name: Upload artifact
        uses: actions/upload-artifact@v5
        with:
          name: bounce-binary
          path: build/bounce
```

### Docker Multi-Stage Build

```dockerfile
# apps/bounce/Dockerfile
FROM golang:1.25.4-alpine3.22 AS builder

# Install dependencies
RUN apk add --no-cache git make

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY apps/bounce ./apps/bounce
COPY Makefile ./

# Build
RUN make build-bounce

# Runtime image
FROM alpine:3.22.2

RUN apk add --no-cache ca-certificates

COPY --from=builder /app/build/bounce /bounce

EXPOSE 8083

CMD ["/bounce"]
```

### Local Development with Makefile

Following Tempest's pattern, we use Makefile targets and goreman for orchestration.

**Important**: Add these to `.gitignore` to prevent committing secrets:
```gitignore
# Local development secrets
.local-dev/
.env.local
```

```makefile
# Makefile additions for local development

# Install development dependencies
setup_dev:
	brew install go@1.25 goreman gow sqlc golangci-lint supabase
	go install github.com/mitranim/gow@latest

# Generate JWT keys for local development
create_jwt_keys:
	@mkdir -p .local-dev/keys
	@openssl genrsa -out .local-dev/keys/private.pem 2048
	@openssl rsa -in .local-dev/keys/private.pem -pubout -out .local-dev/keys/public.pem

# Run bounce service with hot-reload
run_bounce: create_jwt_keys
	JWT_PRIVATE_KEY_PATH=./.local-dev/keys/private.pem \
	JWT_PUBLIC_KEY_PATH=./.local-dev/keys/public.pem \
	DATABASE_URL=$$(op read "op://Engineering/atlas-supabase-dev/database_url") \
	AUTH_SERVICE_URL=http://localhost:8083 \
	APP_URL=http://localhost:1420 \
	COOKIE_DOMAIN=localhost \
	SENDGRID_API_KEY=$$(op read "op://Engineering/sendgrid-local-api-key/credential") \
	SIGNUP_HMAC_SECRET=$$(op read "op://Engineering/atlas-bounce-dev/signup_hmac_secret") \
	gow -w ./apps/bounce run ./apps/bounce

# Run Atlas daemon with existing Deno task
run_atlas_daemon:
	deno task dev

# Run Atlas web client with existing npm script
run_atlas_web:
	cd apps/web-client && \
	ATLAS_AUTH_URL=http://localhost:8083 \
	npm run dev

# Kill all development processes
kill_all:
	pkill -f gow || true
	pkill -f "deno task" || true

# Run all services for development
run_all_dev: kill_all
	goreman -f procfile-dev start
```

Create a `procfile-dev` for goreman:

```procfile
# procfile-dev
bounce: make run_bounce
atlas_daemon: make run_atlas_daemon
atlas_web: make run_atlas_web
```

This approach provides:
- **Hot-reload** via `gow` for Go services
- **Native execution** for faster iteration
- **Simple orchestration** with goreman
- **Clean separation** between services
- **1Password integration** for secrets (optional)
```

## 7. Dependabot Configuration

```yaml
# .github/dependabot.yml (append to existing)
  - package-ecosystem: "gomod"
    directory: "/"
    schedule:
      interval: "daily"
      time: "06:00"
    groups:
      go-dependencies:
        patterns:
          - "*"
        update-types:
          - "minor"
          - "patch"
```

## 8. Database Migrations

### Supabase Migration File

```sql
-- supabase/migrations/20250000000000_atlas_auth_schema.sql

-- Create bounce schema (ported from tempest-core)
CREATE SCHEMA IF NOT EXISTS bounce;

-- Create auth_user table
CREATE TABLE bounce.auth_user (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    last_sign_in_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    email text NOT NULL,
    email_confirmed boolean NOT NULL DEFAULT false,
    email_confirmed_at timestamptz,
    confirmation_token text,
    confirmation_sent_at timestamptz,
    UNIQUE (email)
);

-- Create identity provider enum
CREATE TYPE bounce_identity_provider AS ENUM ('google');

-- Create identity table for OAuth
CREATE TABLE bounce.identity (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    auth_user_id text REFERENCES bounce.auth_user (id) ON DELETE CASCADE,
    email text NOT NULL,
    last_sign_in_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    provider bounce_identity_provider NOT NULL,
    provider_id text NOT NULL,  -- User ID from provider
    provider_app_data jsonb NOT NULL DEFAULT '{}',
    provider_user_data jsonb NOT NULL DEFAULT '{}',
    UNIQUE (provider, provider_id, email)
);

-- Create OTP uses enum
CREATE TYPE bounce_otp_use AS ENUM ('magiclink', 'emailconfirm', 'oauthstate', 'csrf');

-- Create OTP table for magic links and OAuth state
CREATE TABLE bounce.otp (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    code text NOT NULL,
    auth_user_id text REFERENCES bounce.auth_user (id) ON DELETE CASCADE,
    use bounce_otp_use NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    UNIQUE (code, use)
);

-- Create indexes
CREATE INDEX idx_auth_user_email ON bounce.auth_user(email);
CREATE INDEX idx_identity_auth_user_id ON bounce.identity(auth_user_id);
CREATE INDEX idx_identity_provider ON bounce.identity(provider, provider_id);
CREATE INDEX idx_otp_code ON bounce.otp(code, use);
CREATE INDEX idx_otp_expires ON bounce.otp(expires_at);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION bounce.update_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach triggers
CREATE TRIGGER trigger_update_auth_user_updated_at
    BEFORE UPDATE ON bounce.auth_user
    FOR EACH ROW EXECUTE FUNCTION bounce.update_updated_at();

CREATE TRIGGER trigger_update_identity_updated_at
    BEFORE UPDATE ON bounce.identity
    FOR EACH ROW EXECUTE FUNCTION bounce.update_updated_at();

-- Grant permissions for Supabase service role
GRANT USAGE ON SCHEMA bounce TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA bounce TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA bounce TO service_role;
```

### Running Migrations

```bash
# Link to Supabase project
supabase link --project-ref [ATLAS_PROJECT_REF]

# Create and apply migration
supabase migration new atlas_auth_schema
# Copy the SQL above into the generated migration file
supabase db push

# Generate TypeScript types (optional, for Deno services)
supabase gen types typescript --schema public,bounce > packages/@atlas/database/types.ts
```

The bounce service connects directly to Supabase - no migration runner needed in Go code. The schema is already defined in Section 3.

## 9. SQLC Configuration

```yaml
# apps/bounce/repo/sqlc.yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "query.sql"
    schema: "schema.sql"
    gen:
      go:
        package: "repo"
        out: "generated"
        sql_package: "pgx/v5"
        emit_json_tags: true
        emit_db_tags: true
        emit_prepared_queries: false
        emit_exact_table_names: false
        emit_empty_slices: true
        emit_exported_queries: false
        emit_result_struct_pointers: true
        emit_params_struct_pointers: true
        emit_methods_with_db_argument: false
        emit_pointers_for_null_types: true
        emit_enum_valid_method: true
        emit_all_enum_values: true
        json_tags_case_style: "camel"
        output_models_file_name: "models.go"
        output_querier_file_name: "querier.go"
        output_copyfrom_file_name: "copyfrom.go"
        query_parameter_limit: 1000
overrides:
  - db_type: "timestamptz"
    go_type: "time.Time"
  - db_type: "jsonb"
    go_type: "encoding/json.RawMessage"
```

## 10. Testing Strategy

### Unit Tests (Port from Tempest)

```go
// apps/bounce/service/jwt_test.go
package service

import (
    "testing"
    "time"
)

func TestGenerateJWT(t *testing.T) {
    // Port test from tempest-core
    claims := &Claims{
        Email: "test@example.com",
        // ...
    }

    token, err := GenerateJWT(claims)
    if err != nil {
        t.Fatalf("Failed to generate JWT: %v", err)
    }

    // Verify token
    verified, err := VerifyJWT(token)
    if err != nil {
        t.Fatalf("Failed to verify JWT: %v", err)
    }

    if verified.Email != claims.Email {
        t.Errorf("Email mismatch: got %s, want %s", verified.Email, claims.Email)
    }
}
```

### Integration Tests

```go
// apps/bounce/handlers/signup_test.go
package handlers

import (
    "net/http/httptest"
    "testing"
)

func TestSignupFlow(t *testing.T) {
    // Setup test database
    db := setupTestDB(t)
    defer db.Close()

    // Test signup request
    req := httptest.NewRequest("POST", "/signup/email",
        strings.NewReader(`{"email":"test@company.com"}`))
    w := httptest.NewRecorder()

    handleSignupEmail(w, req)

    if w.Code != http.StatusOK {
        t.Errorf("Expected 200, got %d", w.Code)
    }

    // Verify OTP was created
    // ... (port from Tempest tests)
}
```

## 11. Local Development

### Local Traefik Configuration

Create local Traefik configuration files for development:

```yaml
# applications/traefik/local-dev/traefik.yml
log:
  format: json
  level: INFO

accessLog:
  format: json

entryPoints:
  web:
    address: ":1420"
    transport:
      lifeCycle:
        requestAcceptGraceTimeout: 0s
        graceTimeOut: 0s

providers:
  file:
    filename: /etc/traefik/dynamic_conf.yml
    watch: true

experimental:
  plugins:
    redirectErrors:
      moduleName: github.com/indivisible/redirecterrors
      version: v0.1.0
```

```yaml
# applications/traefik/local-dev/dynamic_conf.yml
http:
  routers:
    # Route to Atlas web client by default
    atlas-web:
      entryPoints:
        - web
      rule: Host(`localhost`) && !PathPrefix(`/api`) && !PathPrefix(`/auth`) && !PathPrefix(`/login`) && !PathPrefix(`/signup`) && !PathPrefix(`/provisioning`)
      middlewares:
        - secured
      service: atlas-web

    # Route API calls to Atlas daemon
    atlas-api:
      entryPoints:
        - web
      rule: Host(`localhost`) && PathPrefix(`/api`)
      middlewares:
        - secured
      service: atlas-daemon

    # Unauthenticated auth pages
    auth-pages:
      entryPoints:
        - web
      rule: Host(`localhost`) && (PathPrefix(`/login`) || PathPrefix(`/signup`) || PathPrefix(`/provisioning`))
      service: atlas-auth-ui

    # Bounce API endpoints
    bounce-api:
      entryPoints:
        - web
      rule: |
        Host(`localhost`) && (
          PathPrefix(`/login/email`) ||
          PathPrefix(`/signup/email`) ||
          PathPrefix(`/magiclink`) ||
          PathPrefix(`/oauth/google`)
        )
      service: atlas-bounce

  middlewares:
    secured:
      chain:
        middlewares:
          - http-error-redirect
          - extract-userid-local

    extract-userid-local:
      forwardAuth:
        address: "http://localhost:8083/forwardauth"
        trustForwardHeader: true
        authRequestHeaders:
          - "Cookie"

    http-error-redirect:
      plugin:
        redirectErrors:
          status:
            - "401"
          target: "/login"
          outputStatus: 302

  services:
    atlas-web:
      loadBalancer:
        servers:
          - url: http://localhost:5173/  # Vite dev server

    atlas-daemon:
      loadBalancer:
        servers:
          - url: http://localhost:8080/

    atlas-bounce:
      loadBalancer:
        servers:
          - url: http://localhost:8083/

    atlas-auth-ui:
      loadBalancer:
        servers:
          - url: http://localhost:8084/
```

### Makefile Setup

Add these targets to the main Atlas Makefile:

```makefile
# Atlas Authentication Development Targets

.PHONY: help-auth
help-auth: ## Show auth-related make targets
	@echo "Authentication Development Targets:"
	@echo "  make generate-jwt-keys    - Generate RSA key pair for JWT signing"
	@echo "  make build-bounce         - Build bounce authentication service"
	@echo "  make run-bounce          - Run bounce service locally"
	@echo "  make test-bounce         - Run bounce service tests"
	@echo "  make generate-sqlc       - Generate SQLc code for database queries"

.PHONY: generate-jwt-keys
generate-jwt-keys: ## Generate JWT RSA key pair for local development
	@mkdir -p .local-dev
	@if [ ! -f .local-dev/jwt_private_key.pem ]; then \
		echo "Generating JWT RSA key pair..."; \
		openssl genrsa -out .local-dev/jwt_private_key.pem 2048; \
		openssl rsa -in .local-dev/jwt_private_key.pem -pubout -out .local-dev/jwt_public_key.pem; \
		echo "Keys generated in .local-dev/"; \
	else \
		echo "JWT keys already exist in .local-dev/"; \
	fi

.PHONY: build-bounce
build-bounce: ## Build the bounce authentication service
	@echo "Building bounce service..."
	@cd services/bounce && go build -o ../../build/bounce ./cmd/bounce

.PHONY: run-traefik-local
run-traefik-local: ## Run Traefik for local development
	@echo "Starting local Traefik..."
	@docker run -d --rm --name atlas-traefik-local \
		-p 1420:1420 \
		-v $(PWD)/applications/traefik/local-dev/traefik.yml:/etc/traefik/traefik.yml \
		-v $(PWD)/applications/traefik/local-dev/dynamic_conf.yml:/etc/traefik/dynamic_conf.yml \
		traefik:v3.1

.PHONY: stop-traefik-local
stop-traefik-local: ## Stop local Traefik
	@docker stop atlas-traefik-local 2>/dev/null || true

.PHONY: run-bounce
run-bounce: generate-jwt-keys ## Run bounce service locally
	@echo "Starting bounce service..."
	@JWT_PRIVATE_KEY_FILE=./.local-dev/jwt_private_key.pem \
	JWT_PUBLIC_KEY_FILE=./.local-dev/jwt_public_key.pem \
	DATABASE_URL="$$(op read 'op://Private/Supabase Atlas Dev/url')?search_path=bounce" \
	SENDGRID_API_KEY=$$(op read "op://Private/SendGrid Atlas Dev/api_key" 2>/dev/null || echo "SG.test") \
	OAUTH_GOOGLE_CLIENT_ID=$$(op read "op://Private/Google OAuth Atlas Dev/client_id" 2>/dev/null || echo "") \
	OAUTH_GOOGLE_CLIENT_SECRET=$$(op read "op://Private/Google OAuth Atlas Dev/client_secret" 2>/dev/null || echo "") \
	OAUTH_GOOGLE_REDIRECT_URI="http://localhost:1420/oauth/google/callback" \
	PORT=8083 \
	LOG_LEVEL=debug \
	COOKIE_DOMAIN="" \
	COOKIE_PATH="/" \
	COOKIE_SECURE=false \
	APP_URL=http://localhost:1420 \
	AUTH_SERVICE_URL=http://localhost:1420 \
	SIGNUP_HMAC_SECRET=dev-secret-change-in-production \
	WEBHOOK_TOKEN=dev-webhook-token \
	ATLAS_OPERATOR_URL=http://localhost:8082 \
	./build/bounce

.PHONY: run-auth-ui
run-auth-ui: ## Run the auth UI development server
	@echo "Starting auth UI server..."
	@cd services/atlas-auth-ui && \
	python3 -m http.server 8084 --directory ./

.PHONY: test-bounce
test-bounce: ## Run bounce service tests
	@echo "Running bounce tests..."
	@cd services/bounce && go test -v ./...

.PHONY: generate-sqlc
generate-sqlc: ## Generate SQLc code for database queries
	@echo "Generating SQLc code..."
	@cd services/bounce && sqlc generate

.PHONY: dev-auth
dev-auth: ## Run full auth stack locally (bounce + auth-ui + atlas)
	@echo "Starting authentication stack..."
	@$(MAKE) run-bounce &
	@$(MAKE) run-auth-ui &
	@deno task dev

# Setup target for first-time development
.PHONY: setup-auth-dev
setup-auth-dev: ## Setup authentication development environment
	@echo "Setting up authentication development..."
	@# Install Go if needed
	@if ! command -v go > /dev/null; then \
		echo "Installing Go..."; \
		brew install go; \
	fi
	@# Install SQLc
	@if ! command -v sqlc > /dev/null; then \
		echo "Installing SQLc..."; \
		go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest; \
	fi
	@# Generate JWT keys
	@$(MAKE) generate-jwt-keys
	@# Create local dev secrets file template
	@mkdir -p .local-dev
	@if [ ! -f .local-dev/sendgrid_api_key ]; then \
		echo "SG.test" > .local-dev/sendgrid_api_key; \
	fi
	@echo "Setup complete! Run 'make dev-auth' to start development stack"
```

### Development Setup

```bash
# 1. Initial setup (run once)
make setup-auth-dev

# 2. Start development stack (in separate terminals)
# Terminal 1: Run bounce service
make run-bounce

# Terminal 2: Run auth UI server
make run-auth-ui

# Terminal 3: Run Atlas daemon with web client
deno task dev

# Or run everything together:
make dev-auth
```

### Local Development URLs

- Atlas App: http://localhost:1420
- Bounce API: http://localhost:8083
- Auth UI: http://localhost:8084
- Health Check: http://localhost:8083/health

### Testing Authentication Flow Locally

```bash
# 1. Visit http://localhost:1420
# 2. Get redirected to http://localhost:8084/login
# 3. Enter email and receive magic link (console output in dev mode)
# 4. Click magic link to authenticate
# 5. Get redirected back to Atlas app with JWT cookie
```

### .gitignore Updates

Ensure these entries are in the project .gitignore:

```gitignore
# Local development secrets
.local-dev/
*.pem
*.key
*.crt

# Build artifacts
build/
dist/

# Go specific
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
vendor/
```

## 12. Production Deployment

### Namespace Architecture

Atlas uses a multi-namespace strategy:
- **`atlas`** - Deno/TypeScript services (atlasd, web-client)
- **`atlas-operator`** - Go backend services (auth, future services)

This separation provides:
- Clear language/runtime boundaries
- Independent scaling and resource management
- Easier debugging and monitoring
- Potential for different security policies

### Kubernetes Manifests

```yaml
# k8s/auth-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atlas-bounce
  namespace: atlas-operator  # Go services in operator namespace
spec:
  replicas: 2
  selector:
    matchLabels:
      app: atlas-bounce
  template:
    metadata:
      labels:
        app: atlas-bounce
        component: backend
        language: go
    spec:
      serviceAccountName: atlas-bounce-sa
      initContainers:
        - name: secrets
          image: us-west2-docker.pkg.dev/tempest-sandbox/gsm-init/gsm-init:latest
          command: ["/gsm-init"]
          args:
            - "-output-dir=/secrets/app"
            - "-project-id=tempest-sandbox"
            - "-secret=atlas-jwt-private-key"
            - "-secret=atlas-jwt-public-key"
            - "-secret=atlas-sendgrid-api-key"
            - "-secret=atlas-auth-env"
          volumeMounts:
            - name: secrets
              mountPath: /secrets
      containers:
        - name: bounce
          image: us-west2-docker.pkg.dev/tempest-sandbox/atlas/bounce:latest
          ports:
            - containerPort: 8083
              name: http
          env:
            - name: DOT_ENV
              value: /secrets/app/atlas-auth-env
            - name: JWT_PRIVATE_KEY_PATH
              value: /secrets/app/atlas-jwt-private-key
            - name: JWT_PUBLIC_KEY_PATH
              value: /secrets/app/atlas-jwt-public-key
            - name: SENDGRID_API_KEY_FILE
              value: /secrets/app/atlas-sendgrid-api-key
          volumeMounts:
            - name: secrets
              mountPath: /secrets
              readOnly: true
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
      volumes:
        - name: secrets
          emptyDir:
            medium: Memory
---
apiVersion: v1
kind: Service
metadata:
  name: atlas-bounce
  namespace: atlas-operator  # Service in same namespace
spec:
  selector:
    app: atlas-bounce
  ports:
    - port: 8083
      targetPort: http
      name: http
```

## 13. Atlas Auth UI Service

Since Atlas instances are per-user and created after authentication, we need a separate always-available service for authentication pages.

### Service Structure

```
services/atlas-auth-ui/
├── Dockerfile
├── nginx.conf
└── public/
    ├── login.html
    ├── signup.html
    ├── verify.html
    ├── complete-setup.html
    ├── provisioning.html
    ├── styles.css
    └── scripts.js
```

### Dockerfile

```dockerfile
# services/atlas-auth-ui/Dockerfile
FROM nginx:alpine

# Copy static files
COPY public /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Nginx Configuration

```nginx
# services/atlas-auth-ui/nginx.conf
events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    server {
        listen 80;
        server_name _;
        root /usr/share/nginx/html;
        index index.html;

        # Security headers
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Content-Security-Policy "default-src 'self' https://auth.atlas.tempestdx.dev; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';" always;

        # Serve static files
        location / {
            try_files $uri $uri/ /index.html;
        }

        # Cache static assets
        location ~* \.(css|js|jpg|jpeg|png|gif|ico|svg)$ {
            expires 1h;
            add_header Cache-Control "public, immutable";
        }
    }
}
```

### Deployment

```yaml
# k8s/atlas-auth-ui-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atlas-auth-ui
  namespace: atlas-operator
spec:
  replicas: 2
  selector:
    matchLabels:
      app: atlas-auth-ui
  template:
    metadata:
      labels:
        app: atlas-auth-ui
    spec:
      containers:
        - name: auth-ui
          image: us-west2-docker.pkg.dev/tempest-sandbox/atlas/auth-ui:latest
          ports:
            - containerPort: 80
          resources:
            limits:
              memory: "128Mi"
              cpu: "100m"
---
apiVersion: v1
kind: Service
metadata:
  name: atlas-auth-ui
  namespace: atlas-operator
spec:
  selector:
    app: atlas-auth-ui
  ports:
    - port: 80
      targetPort: 80
```

### Login Page (`services/atlas-auth-ui/public/login.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' https://auth.atlas.tempestdx.dev; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';">
  <meta http-equiv="X-Content-Type-Options" content="nosniff">
  <meta http-equiv="X-Frame-Options" content="DENY">
  <title>Sign in to Atlas</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="auth-container">
    <h1>Sign in to Atlas</h1>

    <form id="login-form">
      <div class="form-group">
        <label for="email">Work Email</label>
        <input
          type="email"
          id="email"
          name="email"
          required
          placeholder="you@company.com"
        />
      </div>

      <div id="error-message" class="error-message" style="display: none;"></div>

      <button type="submit" id="submit-btn">
        <span class="btn-text">Continue with Email</span>
        <span class="btn-loading" style="display: none;">Sending...</span>
      </button>
    </form>

    <div class="divider">
      <span>or</span>
    </div>

    <button class="google-button" onclick="handleGoogleLogin()">
      <svg width="18" height="18" viewBox="0 0 18 18"><!-- Google icon SVG --></svg>
      Continue with Google
    </button>

    <p class="signup-link">
      Don't have an account? <a href="/signup">Sign up</a>
    </p>
  </div>

  <script>
    const API_URL = 'https://auth.atlas.tempestdx.dev';  // Bounce service

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const email = document.getElementById('email').value;
      const submitBtn = document.getElementById('submit-btn');
      const errorDiv = document.getElementById('error-message');

      // Show loading state
      submitBtn.disabled = true;
      submitBtn.querySelector('.btn-text').style.display = 'none';
      submitBtn.querySelector('.btn-loading').style.display = 'inline';
      errorDiv.style.display = 'none';

      try {
        const response = await fetch(`${API_URL}/login/email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email }),
          credentials: 'include'
        });

        if (response.ok) {
          // Show success message inline
          document.querySelector('.auth-container').innerHTML = `
            <h1>Check your email</h1>
            <p>We've sent a magic link to ${email}</p>
            <p>Click the link in the email to sign in.</p>
            <a href="/login">Back to login</a>
          `;
        } else {
          const data = await response.json();
          errorDiv.textContent = data.error || 'Failed to send login email';
          errorDiv.style.display = 'block';
        }
      } catch (err) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.querySelector('.btn-text').style.display = 'inline';
        submitBtn.querySelector('.btn-loading').style.display = 'none';
      }
    });

    function handleGoogleLogin() {
      // Redirect to OAuth authorize endpoint
      // The bounce service will handle state generation and redirect URI
      const redirectTo = encodeURIComponent(window.location.origin);
      window.location.href = `${API_URL}/oauth/google/authorize?redirect_to=${redirectTo}`;
    }
  </script>
</body>
</html>
```

### Signup Page (`services/atlas-auth-ui/public/signup.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign up for Atlas</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="auth-container">
    <h1>Create your Atlas account</h1>

    <form id="signup-form">
      <div class="form-group">
        <label for="email">Work Email</label>
        <input
          type="email"
          id="email"
          name="email"
          required
          placeholder="you@company.com"
        />
      </div>

      <div id="error-message" class="error-message" style="display: none;"></div>

      <button type="submit" id="submit-btn">
        <span class="btn-text">Sign up with Email</span>
        <span class="btn-loading" style="display: none;">Sending...</span>
      </button>
    </form>

    <div class="divider">
      <span>or</span>
    </div>

    <button class="google-button" onclick="handleGoogleSignup()">
      <svg width="18" height="18" viewBox="0 0 18 18"><!-- Google icon SVG --></svg>
      Sign up with Google
    </button>

    <p class="signup-link">
      Already have an account? <a href="/login">Sign in</a>
    </p>
  </div>

  <script>
    const API_URL = 'https://auth.atlas.tempestdx.dev';

    document.getElementById('signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const email = document.getElementById('email').value;
      const submitBtn = document.getElementById('submit-btn');
      const errorDiv = document.getElementById('error-message');

      submitBtn.disabled = true;
      submitBtn.querySelector('.btn-text').style.display = 'none';
      submitBtn.querySelector('.btn-loading').style.display = 'inline';
      errorDiv.style.display = 'none';

      try {
        const response = await fetch(`${API_URL}/signup/email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email }),
          credentials: 'include'
        });

        if (response.ok) {
          document.querySelector('.auth-container').innerHTML = `
            <h1>Check your email</h1>
            <p>We've sent a confirmation email to ${email}</p>
            <p>Click the link in the email to confirm your account.</p>
            <a href="/signup">Back to signup</a>
          `;
        } else {
          const data = await response.json();
          errorDiv.textContent = data.error || 'Failed to send signup email';
          errorDiv.style.display = 'block';
        }
      } catch (err) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.querySelector('.btn-text').style.display = 'inline';
        submitBtn.querySelector('.btn-loading').style.display = 'none';
      }
    });

    function handleGoogleSignup() {
      window.location.href = `${API_URL}/oauth/google/authorize?redirect_to=${encodeURIComponent(window.location.origin)}`;
    }
  </script>
</body>
</html>
```

### Complete Setup Page (`services/atlas-auth-ui/public/complete-setup.html`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Complete Your Profile - Atlas</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="auth-container">
    <h1>Complete Your Profile</h1>

    <form id="complete-setup-form">
      <div class="form-group">
        <label for="fullName">Full Name</label>
        <input
          type="text"
          id="fullName"
          name="fullName"
          required
          placeholder="John Doe"
        />
      </div>

      <div class="form-group">
        <label for="displayName">Display Name (optional)</label>
        <input
          type="text"
          id="displayName"
          name="displayName"
          placeholder="JDoe"
        />
      </div>

      <div id="error-message" class="error-message" style="display: none;"></div>

      <button type="submit" id="submit-btn">
        <span class="btn-text">Complete Setup</span>
        <span class="btn-loading" style="display: none;">Saving...</span>
      </button>
    </form>
  </div>

  <script>
    const API_URL = 'https://auth.atlas.tempestdx.dev';

    document.getElementById('complete-setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();

      const data = {
        userFullName: document.getElementById('fullName').value,
        userDisplayName: document.getElementById('displayName').value || ''
      };

      const submitBtn = document.getElementById('submit-btn');
      const errorDiv = document.getElementById('error-message');

      submitBtn.disabled = true;
      submitBtn.querySelector('.btn-text').style.display = 'none';
      submitBtn.querySelector('.btn-loading').style.display = 'inline';
      errorDiv.style.display = 'none';

      try {
        const response = await fetch(`${API_URL}/signup/complete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(data),
          credentials: 'include'
        });

        if (response.ok) {
          // Redirect to main app
          window.location.href = 'https://app.atlas.tempestdx.dev';
        } else {
          const data = await response.json();
          errorDiv.textContent = data.error || 'Failed to complete setup';
          errorDiv.style.display = 'block';
        }
      } catch (err) {
        errorDiv.textContent = 'Network error. Please try again.';
        errorDiv.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.querySelector('.btn-text').style.display = 'inline';
        submitBtn.querySelector('.btn-loading').style.display = 'none';
      }
    });
  </script>
</body>
</html>
```

### Styles CSS (`services/atlas-auth-ui/public/styles.css`)

```css
/* services/atlas-auth-ui/public/styles.css */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.auth-container {
  width: 100%;
  max-width: 400px;
  padding: 20px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.auth-container h1 {
  color: #333;
  text-align: center;
  margin-bottom: 30px;
  font-size: 1.5rem;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 5px;
  color: #555;
  font-size: 14px;
  font-weight: 500;
}

input[type="email"],
input[type="text"] {
  width: 100%;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 16px;
  transition: border-color 0.3s;
}

input:focus {
  outline: none;
  border-color: #667eea;
}

button {
  width: 100%;
  padding: 12px;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.3s;
}

button:hover {
  background: #5a67d8;
}

button:disabled {
  background: #ccc;
  cursor: not-allowed;
}

.google-button {
  background: white;
  color: #333;
  border: 1px solid #ddd;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.google-button:hover {
  background: #f7f7f7;
}

.divider {
  text-align: center;
  margin: 20px 0;
  position: relative;
}

.divider span {
  background: white;
  padding: 0 10px;
  color: #999;
  position: relative;
  z-index: 1;
}

.divider::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: #ddd;
}

.error-message {
  background: #fee;
  color: #c00;
  padding: 10px;
  border-radius: 4px;
  margin-bottom: 15px;
  font-size: 14px;
}

.signup-link {
  text-align: center;
  margin-top: 20px;
  color: #666;
  font-size: 14px;
}

.signup-link a {
  color: #667eea;
  text-decoration: none;
}

.signup-link a:hover {
  text-decoration: underline;
}

.btn-loading {
  display: none;
}

/* Provisioning page specific styles */
.provisioning-container {
  text-align: center;
  background: transparent;
  box-shadow: none;
}

.provisioning-container h1 {
  color: white;
  margin-bottom: 30px;
}

.spinner {
  width: 50px;
  height: 50px;
  margin: 30px auto;
  border: 3px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status {
  color: rgba(255, 255, 255, 0.9);
  margin-top: 20px;
}
```

### Signup Page [OLD - Remove] (`apps/web-client/src/routes/signup/+page.svelte`)

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { PUBLIC_AUTH_URL } from '$env/static/public';

  let email = '';
  let loading = false;
  let error = '';
  let success = false;

  async function handleSignup(e: Event) {
    e.preventDefault();
    loading = true;
    error = '';

    try {
      const response = await fetch(`${PUBLIC_AUTH_URL}/signup/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        credentials: 'include'
      });

      const data = await response.json();

      if (response.ok) {
        success = true;
      } else {
        error = data.error || 'Failed to send signup email';
      }
    } catch (err) {
      error = 'Network error. Please try again.';
    } finally {
      loading = false;
    }
  }
</script>

{#if success}
  <div class="auth-container">
    <h1>Check your email</h1>
    <p>We've sent a verification link to <strong>{email}</strong></p>
    <p>Click the link in the email to complete your signup.</p>
    <a href="/login">Back to login</a>
  </div>
{:else}
  <div class="auth-container">
    <h1>Create your Atlas account</h1>

    <form on:submit={handleSignup}>
      <div class="form-group">
        <label for="email">Work Email</label>
        <input
          type="email"
          id="email"
          bind:value={email}
          required
          placeholder="you@company.com"
          disabled={loading}
        />
        <small>We require a business email address</small>
      </div>

      {#if error}
        <div class="error-message">{error}</div>
      {/if}

      <button type="submit" disabled={loading}>
        {loading ? 'Creating account...' : 'Create account'}
      </button>
    </form>

    <div class="divider">
      <span>or</span>
    </div>

    <button class="google-button" on:click={() => {
      window.location.href = `${PUBLIC_AUTH_URL}/oauth/google?signup=true&redirect_to=${encodeURIComponent(window.location.origin)}`;
    }}>
      <svg><!-- Google icon --></svg>
      Sign up with Google
    </button>

    <p class="login-link">
      Already have an account? <a href="/login">Sign in</a>
    </p>
  </div>
{/if}
```

### Email Verification Handler (`apps/web-client/src/routes/verify/+page.svelte`)

```svelte
<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  let verifying = true;
  let error = '';

  onMount(async () => {
    const token = $page.url.searchParams.get('t');

    if (!token) {
      error = 'Invalid verification link';
      verifying = false;
      return;
    }

    // Redirect to bounce service to verify
    window.location.href = `${PUBLIC_AUTH_URL}/signup/email/verify?t=${token}`;
  });
</script>

<div class="auth-container">
  {#if verifying}
    <h1>Verifying your email...</h1>
    <div class="spinner"></div>
  {:else if error}
    <h1>Verification failed</h1>
    <p class="error-message">{error}</p>
    <a href="/signup">Try again</a>
  {/if}
</div>
```

### Complete Setup Page (`apps/web-client/src/routes/complete-setup/+page.svelte`)

```svelte
<script lang="ts">
  import { goto } from '$app/navigation';
  import { PUBLIC_AUTH_URL } from '$env/static/public';

  let fullName = '';
  let displayName = '';
  let loading = false;
  let error = '';

  async function handleComplete(e: Event) {
    e.preventDefault();
    loading = true;
    error = '';

    try {
      const response = await fetch(`${PUBLIC_AUTH_URL}/signup/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName,
          display_name: displayName || fullName
        }),
        credentials: 'include'
      });

      if (response.ok) {
        // Redirect to main app
        goto('/');
      } else {
        const data = await response.json();
        error = data.error || 'Failed to complete setup';
      }
    } catch (err) {
      error = 'Network error. Please try again.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="auth-container">
  <h1>Complete your profile</h1>

  <form on:submit={handleComplete}>
    <div class="form-group">
      <label for="fullName">Full Name *</label>
      <input
        type="text"
        id="fullName"
        bind:value={fullName}
        required
        placeholder="Jane Smith"
        disabled={loading}
      />
    </div>

    <div class="form-group">
      <label for="displayName">Display Name (optional)</label>
      <input
        type="text"
        id="displayName"
        bind:value={displayName}
        placeholder="Jane"
        disabled={loading}
      />
      <small>How you'll appear in Atlas</small>
    </div>

    {#if error}
      <div class="error-message">{error}</div>
    {/if}

    <button type="submit" disabled={loading || !fullName}>
      {loading ? 'Setting up...' : 'Complete setup'}
    </button>
  </form>
</div>
```

### Protected Route Layout (`apps/web-client/src/routes/(app)/+layout.svelte`)

```svelte
<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  // Check if user is authenticated
  onMount(async () => {
    // The cookie will be sent automatically
    const response = await fetch('/api/user', {
      credentials: 'include'
    });

    if (!response.ok) {
      // Not authenticated, redirect to login
      goto(`/login?redirect=${encodeURIComponent($page.url.pathname)}`);
    }
  });
</script>

<slot />
```

### Environment Configuration

```bash
# apps/web-client/.env.development
PUBLIC_AUTH_URL=http://localhost:8083
PUBLIC_APP_URL=http://localhost:1420

# apps/web-client/.env.production
PUBLIC_AUTH_URL=https://auth.atlas.tempestdx.dev
PUBLIC_APP_URL=https://app.atlas.tempestdx.dev
```

### Styles (`apps/web-client/src/styles/auth.css`)

```css
.auth-container {
  max-width: 400px;
  margin: 100px auto;
  padding: 2rem;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.auth-container h1 {
  font-size: 1.5rem;
  margin-bottom: 1.5rem;
  text-align: center;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
}

.form-group input {
  width: 100%;
  padding: 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
}

.form-group small {
  display: block;
  margin-top: 0.25rem;
  color: #666;
  font-size: 0.875rem;
}

button[type="submit"] {
  width: 100%;
  padding: 0.75rem;
  background: #000;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
}

button[type="submit"]:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.google-button {
  width: 100%;
  padding: 0.75rem;
  background: white;
  color: #333;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}

.divider {
  text-align: center;
  margin: 1.5rem 0;
  position: relative;
}

.divider::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background: #ddd;
}

.divider span {
  background: white;
  padding: 0 1rem;
  position: relative;
  color: #666;
}

.error-message {
  padding: 0.75rem;
  background: #fee;
  color: #c00;
  border-radius: 4px;
  margin-bottom: 1rem;
}

.success-message {
  padding: 0.75rem;
  background: #efe;
  color: #060;
  border-radius: 4px;
  margin-bottom: 1rem;
}
```

## 14. Migration Steps
- [ ] Create Kubernetes manifests
- [ ] Setup secrets in Google Secret Manager
- [ ] Deploy to staging environment
- [ ] Production deployment
- [ ] Monitor and fix issues

## 14. Key Differences from Original Tempest

| Component | Tempest | Atlas |
|-----------|---------|-------|
| Organizations | Required | Removed |
| User Model | Linked to orgs | Standalone |
| JWT Audience | Org context | Simple ['atlas'] |
| Forward Auth | Traefik middleware | Proxy through atlasd |
| Deployment | Separate service | Part of Atlas monorepo |
| Schema | bounce + public | bounce + public (same) |

## 15. JWT Public Key Distribution

The JWT public key is distributed to services via Google Secret Manager:

### Production Setup

```bash
# 1. Create JWT key pair
openssl genrsa -out jwt_private.pem 2048
openssl rsa -in jwt_private.pem -pubout -out jwt_public.pem

# 2. Upload to Google Secret Manager
gcloud secrets create atlas-jwt-private-key --data-file=jwt_private.pem
gcloud secrets create atlas-jwt-public-key --data-file=jwt_public.pem

# 3. Grant access to service accounts
gcloud secrets add-iam-policy-binding atlas-jwt-public-key \
    --member="serviceAccount:atlas-traefik-sa@tempest-sandbox.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"

gcloud secrets add-iam-policy-binding atlas-jwt-private-key \
    --member="serviceAccount:atlas-bounce-sa@tempest-sandbox.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

### Service Configuration

**Traefik** (extractuserid middleware):
- Uses initContainer with `gsm-init` to fetch public key
- Mounts at `/secrets/app/jwt-public-key-pem`
- Middleware references this path in configuration

**Bounce** service:
- Uses initContainer to fetch both private and public keys
- Private key for signing new JWTs
- Public key for validating existing JWTs

### Local Development

For local development, keys are generated and stored in `.local-dev/`:

```bash
make generate-jwt-keys
# Creates:
#   .local-dev/jwt_private_key.pem
#   .local-dev/jwt_public_key.pem
```

## 16. Google OAuth Configuration

### Google Cloud Console Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to "APIs & Services" > "Credentials"
3. Create OAuth 2.0 Client ID
4. Configure:
   - Application type: Web application
   - Name: Atlas Authentication
   - Authorized JavaScript origins:
     - `https://auth.atlas.tempestdx.dev`
     - `http://localhost:1420` (for development)
   - Authorized redirect URIs:
     - `https://auth.atlas.tempestdx.dev/oauth/google/callback`
     - `http://localhost:1420/oauth/google/callback` (for development)
5. Save Client ID and Client Secret in Google Secret Manager

### Bounce OAuth Configuration

```go
// OAuth2 config in bounce
oauth2Config := &oauth2.Config{
    ClientID:     cfg.OAuthGoogleClientID,
    ClientSecret: cfg.OAuthGoogleClientSecret,
    RedirectURL:  cfg.OAuthGoogleRedirectURI,
    Scopes: []string{
        "openid",
        "email",
        "profile",
    },
    Endpoint: google.Endpoint,
}
```

## 17. Auth UI Pages with Nginx Configuration

### Nginx Setup for Static Auth Pages

Similar to web-client, atlas-auth-ui uses nginx to serve static HTML/CSS/JS:

```dockerfile
# apps/atlas-auth-ui/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build  # Build static HTML/CSS/JS

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

```nginx
# apps/atlas-auth-ui/nginx.conf
server {
    listen 80;
    listen [::]:80;
    server_name _;

    # Security
    server_tokens off;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    root /usr/share/nginx/html;
    index index.html;

    # Enable gzip
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/json;

    # Auth pages (no SPA fallback - each page is separate)
    location /login {
        try_files /login.html =404;
    }

    location /signup {
        try_files /signup.html =404;
    }

    location /complete-setup {
        try_files /complete-setup.html =404;
    }

    location /provisioning {
        try_files /provisioning.html =404;
    }

    location /signup-retry {
        try_files /signup-retry.html =404;
    }

    # Verify redirects to bounce service
    location /signup/email/verify {
        return 302 https://auth.atlas.tempestdx.dev$request_uri;
    }

    # OAuth redirects to bounce service
    location /oauth/ {
        return 302 https://auth.atlas.tempestdx.dev$request_uri;
    }

    # Static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Block sensitive files
    location ~* \.(bak|config|log|sql|env)$ {
        deny all;
        return 403;
    }

    # Block hidden files
    location ~ /\. {
        deny all;
        return 403;
    }
}
```

### Static Page Structure

```
apps/atlas-auth-ui/
├── src/
│   ├── login.html
│   ├── signup.html
│   ├── complete-setup.html
│   ├── provisioning.html
│   ├── signup-retry.html
│   ├── styles/
│   │   └── auth.css
│   └── scripts/
│       ├── auth.js
│       └── provisioning.js
├── nginx.conf
├── Dockerfile
└── package.json
```

### Pages to Create

1. **Login Page** (`/login.html`)
   - Email input for magic link
   - Google OAuth button
   - Links to signup

2. **Signup Page** (`/signup.html`)
   - Email input for signup
   - Google OAuth button
   - Links to login

3. **Complete Setup Page** (`/complete-setup.html`)
   - User profile form (full name, profile photo)
   - No organization creation (Atlas doesn't use orgs)
   - Submit to bounce `/signup/complete` endpoint

4. **Provisioning Page** (`/provisioning.html`)
   - "Setting up your workspace..." message
   - Poll `/health` endpoint for instance readiness
   - Auto-redirect when instance is ready

5. **Signup Retry Page** (`/signup-retry.html`)
   - Error message for expired/invalid tokens
   - Option to resend signup email

### Implementation Notes

- Pages make API calls to `https://auth.atlas.tempestdx.dev` (bounce service)
- Use fetch API with `credentials: 'include'` for cookies
- Style consistently with Atlas UI
- No React/Vue/framework needed - plain HTML/JS

### SendGrid Email Templates

**Note**: SendGrid template IDs used in code:
- `SIGNUP_CONFIRMATION_SENDGRID_TEMPLATE_ID = "d-fe853da3d694420d82c4f12fb6f9bc4b"`
- `MAGIC_LINK_SENDGRID_TEMPLATE_ID = "d-2dfcc0e1598c4bdabc5254649f2a7153"`

## 18. Production Secrets Management

Following the pattern from tempest-kustomize, use Google Secret Manager:

```yaml
# k8s/bounce-deployment.yaml
spec:
  template:
    spec:
      initContainers:
      - name: secrets
        image: gcr.io/tempest-dx/gsm-init:latest
        command: ["/gsm-init"]
        args:
          - "-output-dir=/secrets/app"
          - "-project-id=tempest-production"
          - "-secret=atlas-jwt-private-key"
          - "-secret=atlas-jwt-public-key"
          - "-secret=atlas-sendgrid-api-key"
          - "-secret=atlas-google-oauth-credentials"
          - "-secret=atlas-signup-hmac-secret"  # Shared with atlas-operator
        volumeMounts:
        - name: secrets
          mountPath: /secrets
      containers:
      - name: bounce
        env:
        - name: JWT_PRIVATE_KEY_FILE
          value: "/secrets/app/atlas-jwt-private-key"
        - name: JWT_PUBLIC_KEY_FILE
          value: "/secrets/app/atlas-jwt-public-key"
        - name: SENDGRID_API_KEY_FILE
          value: "/secrets/app/atlas-sendgrid-api-key"
        - name: OAUTH_GOOGLE_CREDENTIALS_FILE
          value: "/secrets/app/atlas-google-oauth-credentials"
        - name: SIGNUP_HMAC_SECRET_FILE
          value: "/secrets/app/atlas-signup-hmac-secret"
        volumeMounts:
        - name: secrets
          mountPath: /secrets
          readOnly: true
      volumes:
      - name: secrets
        emptyDir:
          medium: Memory
```

**Important**: The `atlas-signup-hmac-secret` must be shared between bounce and atlas-operator for webhook authentication:

```yaml
# k8s/atlas-operator-deployment.yaml
spec:
  template:
    spec:
      initContainers:
      - name: secrets
        image: gcr.io/tempest-dx/gsm-init:latest
        command: ["/gsm-init"]
        args:
          - "-output-dir=/secrets/app"
          - "-project-id=tempest-production"
          - "-secret=atlas-signup-hmac-secret"  # Same secret as bounce
        volumeMounts:
        - name: secrets
          mountPath: /secrets
      containers:
      - name: atlas-operator
        env:
        - name: WEBHOOK_SECRET_FILE
          value: "/secrets/app/atlas-signup-hmac-secret"
```

The `gsm-init` container fetches secrets from Google Secret Manager and writes them to the shared volume before the main container starts.

## 19. Validation Checklist

- [ ] All auth endpoints from Tempest work (minus org-specific)
- [ ] JWT tokens are compatible format
- [ ] Email OTP flow works end-to-end
- [ ] Session management works
- [ ] Database migrations run cleanly
- [ ] Go tests pass
- [ ] Integration tests pass
- [ ] Docker builds work
- [ ] Kubernetes deployment successful
- [ ] Can login from web UI

## Follow-up TODOs (Not Critical for Initial Implementation)

### Session Revocation (Deferred)
Currently, logout only clears the cookie client-side. The JWT remains valid for 24 hours. For Phase 1, we'll accept this limitation. Future options:
1. **Add session store for blacklist** - Track revoked JWTs (Phase 2)
2. **Short-lived tokens with refresh** - Reduce JWT to 15 minutes, add refresh token flow
3. **Database-backed sessions** - Check session validity on each request

### Rate Limiting
- Add rate limiting to signup/login endpoints
- Add attempt limits for OTP verification
- Prevent email bombing attacks

### Monitoring & Observability
- Add structured logging for all auth events
- Implement metrics for signup/login success rates
- Add alerting for suspicious activity patterns

### Security Enhancements
- Implement CSRF protection
- Add account lockout after failed attempts
- Consider WebAuthn/passkeys as additional auth method

## Conclusion

This plan ports the battle-tested Tempest authentication service to Atlas with minimal modifications. By maintaining the Go implementation, we:

1. **Preserve proven security patterns** - No risk of introducing bugs through rewriting
2. **Reuse 90% of existing code** - Only removing organization-specific logic
3. **Maintain operational knowledge** - Same monitoring, debugging, and deployment patterns
4. **Enable quick deployment** - Most code is copy-paste with minor edits

The key insight is that **Go and Deno can coexist** in the monorepo:
- Go service handles authentication independently
- Deno services proxy auth requests
- JWT tokens provide the integration point
- Docker Compose and Kubernetes handle orchestration

This approach gets Atlas authentication up and running quickly while maintaining the security and reliability of the Tempest implementation.