# Atlas Authentication User Journey

## Architecture Overview

```mermaid
graph TB
    subgraph "Internet"
        User[User Browser]
    end

    subgraph "Traefik Ingress (atlas-operator namespace)"
        Ingress[app.hellofriday.dev]
        ExtractUserID[extractuserid middleware]
        ErrorRedirect[http-error-redirect middleware]
        ParentRoute[atlas-parent IngressRoute]
    end

    subgraph "atlas-operator namespace"
        AuthUI[atlas-auth-ui<br/>Static Auth Pages]
        Bounce[bounce service<br/>Auth Backend]
        AtlasOp[atlas-operator<br/>Instance Manager<br/>Webhook: /api/v1/refresh]
    end

    subgraph "atlas namespace (per-user instances)"
        subgraph "Pod: atlas-6bd8e78lgpqzw"
            Daemon1[atlas daemon<br/>:8080]
            WebClient1[web-client<br/>:3000]
        end
        subgraph "Pod: atlas-9xf3k2hnrty4m"
            Daemon2[atlas daemon<br/>:8080]
            WebClient2[web-client<br/>:3000]
        end
        IngressRoute1[IngressRoute<br/>matches X-Atlas-User-ID: 6bd8e78lgpqzw]
        IngressRoute2[IngressRoute<br/>matches X-Atlas-User-ID: 9xf3k2hnrty4m]
    end

    subgraph "External Services"
        Supabase[(Supabase<br/>PostgreSQL)]
        Google[Google OAuth]
        SendGrid[SendGrid<br/>Email]
    end
```

## First-Time User Journey (Unauthenticated)

### Phase 1: Initial Access & Redirect to Login

```mermaid
sequenceDiagram
    participant U as User Browser
    participant T as Traefik
    participant E as extractuserid
    participant R as http-error-redirect
    participant A as atlas-auth-ui

    Note over U: User visits app.hellofriday.dev

    U->>T: GET app.hellofriday.dev
    T->>E: Check JWT cookie
    E-->>T: No JWT (401)
    T->>R: Handle 401
    R-->>U: Redirect to /login (302)

    U->>T: GET /login
    T->>A: Serve login page (no auth required)
    A-->>U: Display login form
```

### Phase 2: Authentication

```mermaid
sequenceDiagram
    participant U as User Browser
    participant B as bounce service
    participant S as Supabase
    participant G as Google OAuth
    participant SG as SendGrid

    alt Email Login Flow
        U->>B: POST auth.hellofriday.dev/login/email
        B->>S: Check if user exists
        B->>SG: Send magic link email
        B-->>U: "Check your email"
        Note over U: User clicks email link
        U->>B: GET auth.hellofriday.dev/verify?token=xxx
        B->>S: Validate token
        B->>S: Create/update user
    else Google OAuth Flow
        U->>B: GET auth.hellofriday.dev/oauth/google
        B-->>U: Redirect to Google
        U->>G: Authenticate with Google
        G-->>B: OAuth callback with user info
        B->>S: Create/update user
    end

    B->>B: Generate JWT with user ID
    B-->>U: Set JWT cookie + redirect to app.hellofriday.dev
```

### Phase 3: Instance Provisioning

```mermaid
sequenceDiagram
    participant B as bounce service
    participant O as atlas-operator
    participant S as Supabase
    participant Argo as ArgoCD
    participant K8s as Kubernetes

    Note over B,O: After user creation
    B->>O: POST atlas-operator:8082/api/v1/refresh
    O-->>B: 200 OK

    Note over O: Webhook triggers immediate reconciliation
    O->>S: GetOrganizationUsers()
    S-->>O: Returns users (including new user)
    O->>O: Compare with existing Applications
    O->>Argo: Create Application for new user

    Note over Argo,K8s: ArgoCD deploys resources
    Argo->>K8s: Create Deployment (2 containers)
    Argo->>K8s: Create Service (ports 3000, 8080)
    Argo->>K8s: Create IngressRoute (matches X-Atlas-User-ID header)
    K8s-->>Argo: Resources created
```

### Phase 4: Waiting for Instance & Access

```mermaid
sequenceDiagram
    participant U as User Browser
    participant T as Traefik
    participant E as extractuserid
    participant A as atlas-auth-ui
    participant I as Atlas Instance

    Note over U: Redirected after login
    U->>T: GET app.hellofriday.dev (with JWT)
    T->>E: Validate JWT
    E->>E: Extract user ID from 'sub' claim
    E-->>T: Set X-Atlas-User-ID header (no conversion)
    T->>T: No matching IngressRoute yet
    T-->>U: 404 → Redirect to /provisioning

    U->>A: GET /provisioning
    A-->>U: Display "Setting up workspace..."

    loop Poll until ready
        U->>T: GET /health (with JWT)
        T->>E: Extract user ID
        T->>T: Check for IngressRoute
        alt Instance not ready
            T-->>U: 404 or 502
        else Instance ready
            T->>I: Route to daemon:8080/health
            I-->>U: 200 OK
            Note over U: Redirect to main app
        end
    end

    U->>T: GET / (with JWT)
    T->>T: Match IngressRoute
    T->>I: Route to web-client:3000
    I-->>U: Atlas workspace UI
```

## Returning User Journey (Authenticated)

```mermaid
sequenceDiagram
    participant U as User Browser
    participant T as Traefik
    participant E as extractuserid
    participant I as Atlas Instance

    Note over U: User has valid JWT cookie

    U->>T: GET app.hellofriday.dev
    T->>E: Check JWT cookie
    E->>E: Validate JWT (RS256)
    E->>E: Extract user ID from sub claim
    E-->>T: Set X-Atlas-User-ID header (same as sub)

    T->>T: Match IngressRoute by X-Atlas-User-ID header

    alt Instance exists and running
        T->>I: Route to web-client:3000
        I-->>U: Atlas workspace UI (immediate)
    else Instance doesn't exist (no matching IngressRoute)
        T-->>U: 404 → Redirect to /provisioning
        Note over U: Atlas operator creates instance
        U->>U: Poll /health until ready
        U->>T: GET / (after instance ready)
        T->>I: Route to web-client:3000
        I-->>U: Atlas workspace UI
    end
```

## Key Components

### 1. **Traefik Ingress** (atlas-operator namespace)
- **extractuserid middleware** (forked to Atlas): Validates JWT, extracts user ID from 'sub' claim, sets X-Atlas-User-ID header, returns 401 if invalid
  - Example: User ID `6bd8e78lgpqzw` (base36, lowercase+digits only)
  - **NO HEX CONVERSION** - ID used directly in header from JWT 'sub' claim
- **http-error-redirect middleware**: Catches 401, redirects to /login
- **atlas-parent IngressRoute**: Parent route that applies middleware
- **Per-user IngressRoutes** (in atlas namespace): Match on X-Atlas-User-ID header value
  - Example: `Header(\`X-Atlas-User-ID\`, \`6bd8e78lgpqzw\`)`
  - Routes to service `atlas-6bd8e78lgpqzw`

### 2. **atlas-auth-ui** (atlas-operator namespace)
- Always-available static site
- Serves: `/login`, `/signup`, `/verify`, `/complete-setup`, `/provisioning`
- No authentication required (except /provisioning needs JWT to know which user)

### 3. **bounce service** (atlas-operator namespace)
- Handles authentication logic
- Creates users in Supabase database
- Issues JWT tokens (RS256)
- **Triggers instance creation** via webhook to atlas-operator `/api/v1/refresh`
  - Ensures immediate provisioning instead of waiting for next poll cycle

### 4. **atlas-operator** (atlas-operator namespace)
- **Polls database periodically** (ReconciliationInterval, e.g., every 30s)
- **Webhook endpoint** (`/api/v1/refresh`) for immediate reconciliation
  - Called by bounce after user creation to trigger instant provisioning
  - Authenticated via HMAC signature
- Queries for users in database
- **Automatically creates ArgoCD Applications** for new users found in DB
- ArgoCD then deploys the Atlas instance resources
- Also removes Applications when users are deleted from DB

### 5. **Atlas Instances** (atlas namespace)
- Per-user pods with 2 containers:
  - **atlas daemon** (port 8080): Handles /api/*, /health, /streams/*
  - **web-client** (port 3000): Serves the UI
- Service: `atlas-{userID}` (e.g., `atlas-6bd8e78lgpqzw`) exposing both ports
- IngressRoute: Matches `X-Atlas-User-ID` header, routes by path

## Request Flow Rules

```mermaid
flowchart TD
    Request[Request to app.hellofriday.dev] --> Parent[atlas-parent IngressRoute]
    Parent --> Extract[extractuserid middleware]

    Extract --> Check{JWT Valid?}
    Check -->|No| Return401[Return 401]
    Return401 --> ErrorRedirect[http-error-redirect]
    ErrorRedirect --> LoginPage[Redirect to /login]

    Check -->|Yes| SetHeader[Set X-Atlas-User-ID header directly from JWT sub<br/>NO HEX CONVERSION]
    SetHeader --> FindRoute{Find matching<br/>IngressRoute?}

    FindRoute -->|Not Found| Return404[Return 404]
    Return404 --> ProvisionRedirect[Redirect to /provisioning]

    FindRoute -->|Found| RouteByPath{Route by path}

    RouteByPath -->|/api/*| Daemon8080[atlas daemon:8080]
    RouteByPath -->|/health| Daemon8080
    RouteByPath -->|/streams/*| Daemon8080
    RouteByPath -->|/*| WebClient3000[web-client:3000]

    LoginPage --> AuthUI[atlas-auth-ui service]
    ProvisionRedirect --> AuthUI
```

## State Transitions

```mermaid
stateDiagram-v2
    [*] --> Unauthenticated

    Unauthenticated --> LoginPage: No JWT
    LoginPage --> Authenticating: Submit credentials
    Authenticating --> LoginPage: Invalid credentials
    Authenticating --> Provisioning: Valid credentials (JWT set)

    Provisioning --> CheckingHealth: Poll /health
    CheckingHealth --> Provisioning: 404/502
    CheckingHealth --> WorkspaceActive: 200 OK

    WorkspaceActive --> WorkspaceActive: Use Atlas
    WorkspaceActive --> [*]: Logout

    note right of Provisioning
        Instance creation happens
        in background (30-60s)
    end note

    note right of WorkspaceActive
        Instances remain running
        until explicitly terminated
    end note
```

## Security Flow

```mermaid
graph TB
    subgraph "JWT Token Flow"
        Create[User authenticates]
        Sign[bounce signs JWT<br/>RS256 private key]
        Cookie[Set atlas_token cookie<br/>domain: .hellofriday.dev]
        Validate[extractuserid validates<br/>RS256 public key]
        Extract[Extract user ID from 'sub' claim<br/>e.g., 6bd8e78lgpqzw]
        Header[Add X-Atlas-User-ID header<br/>DIRECTLY - NO HEX CONVERSION]
    end

    Create --> Sign
    Sign --> Cookie
    Cookie --> Validate
    Validate --> Extract
    Extract --> Header

    subgraph "Security Checks"
        Check1[No JWT → 401 → /login]
        Check2[Invalid JWT → 401 → /login]
        Check3[Expired JWT → 401 → /login]
        Check4[Valid JWT → Route to instance]
    end
```


## Error Handling Flows

```mermaid
flowchart TD
    subgraph "Authentication Errors"
        E1[Invalid email domain] --> Block[Show error: Email domain not allowed]
        E2[User not found] --> Create[Create new user]
        E3[Invalid magic link] --> Retry[Show error: Link expired/invalid]
        E4[OAuth failure] --> Login[Return to login]
    end

    subgraph "Instance Errors"
        E5[Instance creation failed] --> Provision[ArgoCD retries]
        E6[Instance unhealthy] --> Restart[Kubernetes restarts pod]
        E7[Instance doesn't exist] --> Wait[Show provisioning page]
    end

    subgraph "Network Errors"
        E8[Traefik down] --> Error503[503 Service Unavailable]
        E9[Bounce service down] --> Error502[502 Bad Gateway]
        E10[Instance crashed] --> Error500[500 Internal Error]
    end
```

## Summary

### First-Time User Flow
1. **Redirected to login** (no JWT)
2. **Authenticate** via email/OAuth
3. **User created** in Supabase
4. **Bounce calls webhook** to trigger immediate reconciliation
5. **JWT issued** as cookie
6. **Provisioning page** shown while instance is created
7. **Instance ready** → Access workspace

### Returning User Flow
1. **JWT validated** by extractuserid
2. **User ID extracted** and set as header
3. **IngressRoute matched** by header
4. **Routed directly** to existing instance

### Key Security Features
- RS256 JWT signing
- HTTPOnly secure cookies
- Domain-locked cookies (`.hellofriday.dev`)
- No JWT = automatic redirect to login
- User ID extraction prevents header injection
- Per-user isolated instances