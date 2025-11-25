# Atlas Operator - Implementation Guide

## Quick Start

### Prerequisites
- Go 1.25.3
- Docker
- Kubernetes cluster with kubectl configured
- ArgoCD installed in the cluster
- Access to the Postgres database
- **Operator SDK v1.41.1** (REQUIRED)

### Project Structure
```
atlas-operator/
├── cmd/
│   └── main.go                 # Entry point
├── pkg/
│   ├── controller/
│   │   └── controller.go       # Main controller logic
│   ├── database/
│   │   ├── client.go          # Database connection
│   │   └── queries.go         # SQL queries
│   ├── argocd/
│   │   ├── client.go          # ArgoCD client
│   │   └── application.go     # Application management
│   └── config/
│       └── config.go          # Configuration management
├── config/
│   ├── rbac/
│   │   ├── role.yaml
│   │   └── role_binding.yaml
│   └── manager/
│       └── manager.yaml
├── Dockerfile
├── Makefile
├── go.mod
├── go.sum
└── .env.example
```

## Step-by-Step Implementation

### Step 1: Initialize Go Project with Operator SDK

```bash
# Install Operator SDK v1.41.1
brew install operator-sdk  # macOS
# or download directly:
wget https://github.com/operator-framework/operator-sdk/releases/download/v1.41.1/operator-sdk_darwin_arm64
chmod +x operator-sdk_darwin_arm64
sudo mv operator-sdk_darwin_arm64 /usr/local/bin/operator-sdk

# Verify installation
operator-sdk version
# Should show: operator-sdk version: "v1.41.1"

# Create project with Operator SDK
operator-sdk init --domain tempest.io --repo github.com/tempestteam/atlas-operator --skip-go-version-check

# The SDK scaffolds the project structure with:
# - Main controller loop
# - Kubernetes client setup (with latest controller-runtime v0.22.3)
# - RBAC manifests
# - Dockerfile
# - Makefile

# Add dependencies for database and config
go get github.com/jmoiron/sqlx
go get github.com/lib/pq
go get github.com/joho/godotenv
go get github.com/caarlos0/env/v11

# The operator-sdk will automatically use:
# - controller-runtime v0.22.3
# - client-go v0.33.x (matching controller-runtime requirements)
# - Latest Kubernetes APIs

# Create a controller (we won't use CRDs for this operator)
# Instead, we'll create a custom controller that watches the database
# Skip the "operator-sdk create api" command since we don't need CRDs
```

### Step 2: Configuration Management

**`.env.example`**:
```env
# Database Configuration
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
ORGANIZATION_ID=your-org-id-1,your-org-id-2  # Comma-separated for multiple orgs

# Operator Configuration
RECONCILIATION_INTERVAL=30s
NAMESPACE=atlas
ARGOCD_NAMESPACE=argocd
ENVIRONMENT=sandbox  # Environment (sandbox/production)

# ArgoCD Repository
GIT_REPO_URL=git@github.com:tempestteam/tempest-kustomize.git
GIT_TARGET_REVISION=HEAD

# Logging
LOG_LEVEL=info
```

**`pkg/config/config.go`**:
```go
package config

import (
    "os"
    "time"
    "log/slog"

    "github.com/caarlos0/env/v11"
    "github.com/joho/godotenv"
)

type Config struct {
    // Database Configuration
    DatabaseURL     string `env:"DATABASE_URL,required"`
    OrganizationIDs string `env:"ORGANIZATION_ID,required"` // Comma-separated list

    // Operator Configuration
    ReconciliationInterval time.Duration `env:"RECONCILIATION_INTERVAL" envDefault:"30s"`
    Namespace             string        `env:"NAMESPACE" envDefault:"atlas"`
    ArgocdNamespace       string        `env:"ARGOCD_NAMESPACE" envDefault:"argocd"`
    Environment          string        `env:"ENVIRONMENT" envDefault:"sandbox"`

    // ArgoCD Repository Configuration
    GitRepoURL        string `env:"GIT_REPO_URL,required"`
    GitTargetRevision string `env:"GIT_TARGET_REVISION" envDefault:"HEAD"`

    // Logging
    LogLevel string `env:"LOG_LEVEL" envDefault:"info"`
}

func Load(logger *slog.Logger) (*Config, error) {
    // Load .env file - check for DOT_ENV env var first (similar to pixel)
    if dotenv := os.Getenv("DOT_ENV"); dotenv != "" {
        err := godotenv.Load(dotenv)
        if err != nil {
            logger.Info("no .env file found, using env vars", "requested", dotenv)
        }
    } else {
        err := godotenv.Load()
        if err != nil {
            logger.Info("no .env file found, using env vars")
        }
    }

    // Parse environment variables into Config struct
    cfg := &Config{}
    if err := env.ParseWithOptions(cfg, env.Options{
        RequiredIfNoDef: true,
    }); err != nil {
        return nil, err
    }

    return cfg, nil
}
```

### Step 3: Database Client

**`pkg/database/client.go`**:
```go
package database

import (
    "fmt"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/lib/pq"
    "github.com/lib/pq"
)

type Client struct {
    db             *sqlx.DB
    organizationID string
}

// User represents a user in the organization_user table.
// We only track organization membership, not user details.
type User struct {
    UserID    string         `db:"user_id"`
    Roles     pq.StringArray `db:"roles"`
    CreatedAt time.Time      `db:"created_at"`
    UpdatedAt time.Time      `db:"updated_at"`
}

func NewClient(databaseURL, organizationID string) (*Client, error) {
    // Connect using sqlx which provides additional features over database/sql
    db, err := sqlx.Connect("postgres", databaseURL)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to database: %w", err)
    }

    // Configure connection pool
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)

    return &Client{
        db:             db,
        organizationID: organizationID,
    }, nil
}

func (c *Client) Close() error {
    return c.db.Close()
}
```

**`pkg/database/queries.go`**:
```go
package database

import (
    "fmt"
)

// GetOrganizationUsers queries the organization_user table to get all users in the organization.
// Note: We only monitor the organization_user table - we don't need the user table details
// because the presence/absence in organization_user determines Atlas installation lifecycle.
func (c *Client) GetOrganizationUsers() ([]User, error) {
    query := `
        SELECT user_id, roles, created_at, updated_at
        FROM organization_user
        WHERE organization_id = $1
        ORDER BY created_at DESC
    `

    var users []User
    // sqlx.Select automatically scans into the slice using struct tags
    err := c.db.Select(&users, query, c.organizationID)
    if err != nil {
        return nil, fmt.Errorf("failed to query users: %w", err)
    }

    return users, nil
}
```

### Step 4: ArgoCD Client

**`pkg/argocd/client.go`**:
```go
package argocd

import (
    "context"
    "fmt"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/client-go/dynamic"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/rest"
    "k8s.io/client-go/tools/clientcmd"
)

type Client struct {
    dynamicClient dynamic.Interface
    namespace     string
}

var applicationGVR = schema.GroupVersionResource{
    Group:    "argoproj.io",
    Version:  "v1alpha1",
    Resource: "applications",
}

func NewClient(namespace string) (*Client, error) {
    config, err := getKubeConfig()
    if err != nil {
        return nil, fmt.Errorf("failed to get kubeconfig: %w", err)
    }

    dynamicClient, err := dynamic.NewForConfig(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create dynamic client: %w", err)
    }

    return &Client{
        dynamicClient: dynamicClient,
        namespace:     namespace,
    }, nil
}

func getKubeConfig() (*rest.Config, error) {
    // Try in-cluster config first
    config, err := rest.InClusterConfig()
    if err != nil {
        // Fall back to kubeconfig
        kubeconfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
            clientcmd.NewDefaultClientConfigLoadingRules(),
            &clientcmd.ConfigOverrides{},
        )
        config, err = kubeconfig.ClientConfig()
        if err != nil {
            return nil, err
        }
    }
    return config, nil
}
```

**`pkg/argocd/application.go`**:
```go
package argocd

import (
    "context"
    "fmt"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func (c *Client) CreateApplication(userID, organizationID string, config ApplicationConfig) error {
    app := buildApplication(userID, organizationID, config)

    _, err := c.dynamicClient.Resource(applicationGVR).
        Namespace(c.namespace).
        Create(context.TODO(), app, metav1.CreateOptions{})

    if err != nil {
        return fmt.Errorf("failed to create application: %w", err)
    }

    return nil
}

func (c *Client) DeleteApplication(appName string) error {
    err := c.dynamicClient.Resource(applicationGVR).
        Namespace(c.namespace).
        Delete(context.TODO(), appName, metav1.DeleteOptions{})

    if err != nil {
        return fmt.Errorf("failed to delete application: %w", err)
    }

    return nil
}

func (c *Client) ListApplications() ([]string, error) {
    list, err := c.dynamicClient.Resource(applicationGVR).
        Namespace(c.namespace).
        List(context.TODO(), metav1.ListOptions{
            LabelSelector: "managed-by=atlas-operator",
        })

    if err != nil {
        return nil, fmt.Errorf("failed to list applications: %w", err)
    }

    var apps []string
    for _, item := range list.Items {
        apps = append(apps, item.GetName())
    }

    return apps, nil
}

type ApplicationConfig struct {
    GitRepoURL        string
    Environment      string  // sandbox or production
    GitTargetRevision string
    DestNamespace    string
}

func buildApplication(userID, organizationID string, config ApplicationConfig) *unstructured.Unstructured {
    appName := fmt.Sprintf("atlas-user-%s", userID)

    return &unstructured.Unstructured{
        Object: map[string]interface{}{
            "apiVersion": "argoproj.io/v1alpha1",
            "kind":       "Application",
            "metadata": map[string]interface{}{
                "name":      appName,
                "namespace": config.DestNamespace,
                "labels": map[string]interface{}{
                    "managed-by":      "atlas-operator",
                    "user-id":        userID,
                    "organization-id": organizationID,
                },
            },
            "spec": map[string]interface{}{
                "destination": map[string]interface{}{
                    "namespace": "atlas",  // Single namespace for all users
                    "server":    "https://kubernetes.default.svc",
                },
                "project": "default",
                "source": map[string]interface{}{
                    "path":           fmt.Sprintf("atlas/overlays/%s", config.Environment),
                    "repoURL":        config.GitRepoURL,
                    "targetRevision": config.GitTargetRevision,
                },
                "syncPolicy": map[string]interface{}{
                    "automated": map[string]interface{}{
                        "prune":    true,
                        "selfHeal": true,
                    },
                },
            },
        },
    }
}
```

### Step 5: Main Controller

**`pkg/controller/controller.go`**:
```go
package controller

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/tempestteam/atlas-operator/pkg/argocd"
    "github.com/tempestteam/atlas-operator/pkg/config"
    "github.com/tempestteam/atlas-operator/pkg/database"
)

type Controller struct {
    config       *config.Config
    dbClient     *database.Client
    argoClient   *argocd.Client
    lastSyncTime time.Time
    knownUsers   map[string]bool
    logger       *slog.Logger
}

func NewController(cfg *config.Config, logger *slog.Logger) (*Controller, error) {
    dbClient, err := database.NewClient(cfg.DatabaseURL, cfg.OrganizationID)
    if err != nil {
        return nil, fmt.Errorf("failed to create database client: %w", err)
    }

    argoClient, err := argocd.NewClient(cfg.ArgocdNamespace)
    if err != nil {
        return nil, fmt.Errorf("failed to create ArgoCD client: %w", err)
    }

    return &Controller{
        config:     cfg,
        dbClient:   dbClient,
        argoClient: argoClient,
        knownUsers: make(map[string]bool),
        logger:     logger,
    }, nil
}

func (c *Controller) Run(ctx context.Context) error {
    c.logger.Info("Starting Atlas Operator",
        "organization_id", c.config.OrganizationID,
        "environment", c.config.Environment,
    )

    // Initial sync
    if err := c.reconcile(); err != nil {
        c.logger.Error("Initial reconciliation failed", "error", err)
    }

    ticker := time.NewTicker(c.config.ReconciliationInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            c.logger.Info("Shutting down controller")
            return nil
        case <-ticker.C:
            if err := c.reconcile(); err != nil {
                c.logger.Error("Reconciliation failed", "error", err)
            }
        }
    }
}

func (c *Controller) reconcile() error {
    c.logger.Debug("Starting reconciliation")
    startTime := time.Now()

    // Get current users from database
    users, err := c.dbClient.GetOrganizationUsers()
    if err != nil {
        return fmt.Errorf("failed to get users: %w", err)
    }

    // Get existing ArgoCD applications
    existingApps, err := c.argoClient.ListApplications()
    if err != nil {
        return fmt.Errorf("failed to list applications: %w", err)
    }

    // Build current state maps
    currentUsers := make(map[string]bool)
    for _, user := range users {
        currentUsers[user.UserID] = true
    }

    existingAppsMap := make(map[string]bool)
    for _, app := range existingApps {
        existingAppsMap[app] = true
    }

    // Create applications for new users
    for _, user := range users {
        appName := fmt.Sprintf("atlas-user-%s", user.UserID)
        if !existingAppsMap[appName] {
            c.logger.Info("Creating application for new user", "user_id", user.UserID)

            appConfig := argocd.ApplicationConfig{
                GitRepoURL:        c.config.GitRepoURL,
                Environment:      c.config.Environment,
                GitTargetRevision: c.config.GitTargetRevision,
                DestNamespace:    c.config.ArgocdNamespace,
            }

            if err := c.argoClient.CreateApplication(user.UserID, c.config.OrganizationID, appConfig); err != nil {
                c.logger.Error("Failed to create application for user", "user_id", user.UserID, "error", err)
                continue
            }

            c.logger.Info("Successfully created application", "user_id", user.UserID)
        }
    }

    // Delete applications for removed users
    for _, app := range existingApps {
        // Extract user ID from app name (atlas-user-<userID>)
        if len(app) > 11 && app[:11] == "atlas-user-" {
            userID := app[11:]
            if !currentUsers[userID] {
                c.logger.Info("Deleting application for removed user", "user_id", userID, "app_name", app)

                if err := c.argoClient.DeleteApplication(app); err != nil {
                    c.logger.Error("Failed to delete application", "app_name", app, "error", err)
                    continue
                }

                c.logger.Info("Successfully deleted application", "app_name", app)
            }
        }
    }

    c.lastSyncTime = startTime
    c.knownUsers = currentUsers

    duration := time.Since(startTime)
    c.logger.Info("Reconciliation completed", "duration", duration)

    return nil
}

func (c *Controller) Shutdown() error {
    if c.dbClient != nil {
        return c.dbClient.Close()
    }
    return nil
}
```

### Step 6: Main Entry Point

**`cmd/main.go`**:
```go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"

    "github.com/tempestteam/atlas-operator/pkg/config"
    "github.com/tempestteam/atlas-operator/pkg/controller"
)

func main() {
    ctx := context.Background()

    // Initialize structured logger
    logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Load configuration
    cfg, err := config.Load(logger)
    if err != nil {
        logger.Error("Failed to load configuration", "error", err)
        os.Exit(1)
    }

    // Set log level based on configuration
    logLevel := slog.LevelInfo
    switch cfg.LogLevel {
    case "debug":
        logLevel = slog.LevelDebug
    case "warn":
        logLevel = slog.LevelWarn
    case "error":
        logLevel = slog.LevelError
    }

    logger = slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
        Level: logLevel,
    }))

    logger.Info("Starting Atlas Operator",
        "organization_id", cfg.OrganizationID,
        "environment", cfg.Environment,
        "reconciliation_interval", cfg.ReconciliationInterval,
    )

    // Create controller
    ctrl, err := controller.NewController(cfg, logger)
    if err != nil {
        logger.Error("Failed to create controller", "error", err)
        os.Exit(1)
    }
    defer ctrl.Shutdown()

    // Setup signal handling
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        <-sigCh
        log.Println("Received shutdown signal")
        cancel()
    }()

    // Run controller
    if err := ctrl.Run(ctx); err != nil {
        log.Fatalf("Controller error: %v", err)
    }

    log.Println("Operator shutdown complete")
}
```

### Step 7: Kustomize Structure for tempest-kustomize Repository

The atlas-operator should be deployed using Kustomize from the `tempest-kustomize` repository. Add the following structure:

```
tempest-kustomize/
├── atlas/                     # Existing Atlas application
│   ├── base/
│   └── overlays/
│       └── sandbox/
└── atlas-operator/            # New operator
    ├── base/
    │   ├── kustomization.yaml
    │   ├── namespace.yaml
    │   ├── deployment.yaml
    │   ├── service-account.yaml
    │   ├── role.yaml
    │   └── role-binding.yaml
    └── overlays/
        ├── sandbox/
        │   ├── kustomization.yaml
        │   └── deployment-patch.yaml
        └── production/
            ├── kustomization.yaml
            └── deployment-patch.yaml
```

### Base Resources

**`atlas-operator/base/kustomization.yaml`**:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: atlas
resources:
  - namespace.yaml
  - service-account.yaml
  - role.yaml
  - role-binding.yaml
  - deployment.yaml
```

**`atlas-operator/base/namespace.yaml`**:
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: atlas-operator
```

**`atlas-operator/base/role.yaml`**:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: atlas-operator
rules:
- apiGroups:
  - argoproj.io
  resources:
  - applications
  verbs:
  - create
  - delete
  - get
  - list
  - patch
  - update
  - watch
- apiGroups:
  - ""
  resources:
  - namespaces
  verbs:
  - create
  - get
  - list
```

**`atlas-operator/base/role-binding.yaml`**:
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: atlas-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: atlas-operator
subjects:
- kind: ServiceAccount
  name: atlas-operator
  namespace: atlas
```

**`atlas-operator/base/service-account.yaml`**:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: atlas-operator
  namespace: atlas
```

**`atlas-operator/base/deployment.yaml`**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atlas-operator
  namespace: atlas
  labels:
    app: atlas-operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app: atlas-operator
  template:
    metadata:
      labels:
        app: atlas-operator
    spec:
      serviceAccountName: atlas-operator
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 266
        fsGroup: 266
      initContainers:
      - name: secrets
        imagePullPolicy: Always
        resources:
          limits:
            cpu: 10m
            memory: 10Mi
            ephemeral-storage: 100Mi
          requests:
            cpu: 10m
            memory: 10Mi
            ephemeral-storage: 100Mi
        command: ["/gsm-init"]
        securityContext:
          runAsUser: 65534
          runAsGroup: 266
          runAsNonRoot: true
          allowPrivilegeEscalation: false
        volumeMounts:
        - name: secrets
          mountPath: /secrets
      containers:
      - name: manager
        image: atlas-operator:latest
        imagePullPolicy: Always
        env:
        # Point to the .env file location (created by gsm-init)
        - name: DOT_ENV
          value: "/secrets/app/atlas-operator-env"
        # These can still be set as env vars for overrides
        - name: ENVIRONMENT
          value: "sandbox"  # or "production" for production cluster
        - name: LOG_LEVEL
          value: "info"
        volumeMounts:
        - name: secrets
          mountPath: /secrets
          readOnly: true
        resources:
          limits:
            cpu: 500m
            memory: 256Mi
          requests:
            cpu: 100m
            memory: 128Mi
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes:
      - name: secrets
        emptyDir:
          medium: Memory
```

### Overlay Resources

**`atlas-operator/overlays/sandbox/kustomization.yaml`**:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: deployment-patch.yaml
```

**`atlas-operator/overlays/sandbox/deployment-patch.yaml`**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atlas-operator
spec:
  template:
    spec:
      initContainers:
      - name: secrets
        image: us-west2-docker.pkg.dev/tempest-sandbox/gsm-init/gsm-init:latest
        args:
          - -output-dir=/secrets/app
          - -project-id=tempest-sandbox
          - -secret=atlas-operator-env
          - -uid=65534
          - -gid=266
      containers:
      - name: manager
        image: us-west2-docker.pkg.dev/tempest-sandbox/atlas-operator/atlas-operator:latest
        env:
        - name: ENVIRONMENT
          value: "sandbox"
```

**`atlas-operator/overlays/production/kustomization.yaml`**:
```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - path: deployment-patch.yaml
```

**`atlas-operator/overlays/production/deployment-patch.yaml`**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atlas-operator
spec:
  template:
    spec:
      initContainers:
      - name: secrets
        image: us-west2-docker.pkg.dev/tempest-production/gsm-init/gsm-init:latest
        args:
          - -output-dir=/secrets/app
          - -project-id=tempest-production
          - -secret=atlas-operator-env
          - -uid=65534
          - -gid=266
      containers:
      - name: manager
        image: us-west2-docker.pkg.dev/tempest-production/atlas-operator/atlas-operator:latest
        env:
        - name: ENVIRONMENT
          value: "production"
```

### Secret Management

The secrets are managed in **Google Secret Manager** (GSM), NOT in the Kustomize repository or as Kubernetes Secrets:

1. **Create secret in GSM** (for sandbox environment):
```bash
# Create the .env content in Google Secret Manager
echo 'DATABASE_URL=postgresql://postgres:password@db.example.com:5432/postgres
ORGANIZATION_ID=your-org-id-1,your-org-id-2  # Comma-separated for multiple orgs
GIT_REPO_URL=git@github.com:tempestteam/tempest-kustomize.git
RECONCILIATION_INTERVAL=30s
ARGOCD_NAMESPACE=argocd' | gcloud secrets create atlas-operator-env \
  --project=tempest-sandbox \
  --data-file=-
```

2. **The gsm-init container** automatically:
   - Fetches the secret from Google Secret Manager
   - Writes it to `/secrets/app/atlas-operator-env`
   - Sets proper permissions (uid/gid)
   - Uses in-memory storage for security

3. **Main container** reads the .env file from the path specified by `DOT_ENV` environment variable

### Step 8: Dockerfile

**`Dockerfile`**:
```dockerfile
# Build stage
FROM golang:1.25-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o atlas-operator cmd/main.go

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

COPY --from=builder /app/atlas-operator .

EXPOSE 8080

CMD ["./atlas-operator"]
```

### Step 9: Makefile

**`Makefile`**:
```makefile
.PHONY: build run test docker-build docker-push deploy clean

BINARY_NAME=atlas-operator
DOCKER_IMAGE=atlas-operator
DOCKER_TAG=latest
NAMESPACE=atlas

# Build the binary
build:
	go build -o bin/$(BINARY_NAME) cmd/main.go

# Run locally
run: build
	./bin/$(BINARY_NAME)

# Run tests
test:
	go test ./... -v

# Build Docker image
docker-build:
	docker build -t $(DOCKER_IMAGE):$(DOCKER_TAG) .

# Push Docker image
docker-push: docker-build
	docker push $(DOCKER_IMAGE):$(DOCKER_TAG)

# Deploy to Kubernetes using Kustomize
deploy:
	kubectl apply -k /path/to/tempest-kustomize/atlas-operator/overlays/$(ENVIRONMENT)

# Clean up
clean:
	rm -f bin/$(BINARY_NAME)
	kubectl delete -k /path/to/tempest-kustomize/atlas-operator/overlays/$(ENVIRONMENT) --ignore-not-found=true

# View logs
logs:
	kubectl logs -n $(NAMESPACE) -l app=atlas-operator -f

# Get operator status
status:
	kubectl get all -n $(NAMESPACE)
```

## Testing the Operator

### 1. Unit Tests

**`pkg/database/queries_test.go`**:
```go
package database

import (
    "testing"
    "github.com/DATA-DOG/go-sqlmock"
    "github.com/stretchr/testify/assert"
)

func TestGetOrganizationUsers(t *testing.T) {
    db, mock, err := sqlmock.New()
    assert.NoError(t, err)
    defer db.Close()

    client := &Client{
        db:             db,
        organizationID: "test-org",
    }

    rows := sqlmock.NewRows([]string{"user_id", "roles", "created_at", "updated_at"}).
        AddRow("user1", "{org_member}", time.Now(), time.Now()).
        AddRow("user2", "{org_admin}", time.Now(), time.Now())

    mock.ExpectQuery("SELECT user_id, roles, created_at, updated_at").
        WithArgs("test-org").
        WillReturnRows(rows)

    users, err := client.GetOrganizationUsers()
    assert.NoError(t, err)
    assert.Len(t, users, 2)
    assert.Equal(t, "user1", users[0].UserID)
}
```

### 2. Local Testing

```bash
# Set up environment variables
export DATABASE_URL="postgresql://postgres:password@localhost:5432/postgres"
export ORGANIZATION_ID="your-org-id-1,your-org-id-2"
export ARGOCD_NAMESPACE="argocd"

# Run the operator locally
make run

# Check logs
tail -f operator.log
```

### 3. Kubernetes Testing

```bash
# Build and push Docker image
make docker-build
make docker-push

# Deploy to cluster using Kustomize
cd /path/to/tempest-kustomize
kubectl apply -k atlas-operator/overlays/sandbox

# Check deployment
kubectl get all -n atlas

# View logs
kubectl logs -n atlas -l app=atlas-operator -f
```

## Production Deployment

### 1. Pre-deployment Checklist

- [ ] Database credentials configured in .env file
- [ ] .env file added to appropriate overlay in tempest-kustomize
- [ ] RBAC permissions verified
- [ ] ArgoCD access tested
- [ ] Resource limits set appropriately
- [ ] Monitoring and alerting configured
- [ ] Backup strategy in place

### 2. Deployment Steps

```bash
# 1. Update .env file in tempest-kustomize repository
cd /path/to/tempest-kustomize
vim atlas-operator/overlays/production/.env

# 2. Commit changes to tempest-kustomize
git add atlas-operator/
git commit -m "Add atlas-operator configuration"
git push

# 3. Deploy using Kustomize (or ArgoCD will auto-deploy if configured)
kubectl apply -k atlas-operator/overlays/production

# 4. Verify deployment
kubectl get deployment -n atlas
kubectl get pods -n atlas

# 5. Check logs
kubectl logs -n atlas -l app=atlas-operator
```

### 3. Monitoring

```bash
# Watch operator logs
kubectl logs -n atlas -l app=atlas-operator -f

# Check ArgoCD applications
kubectl get applications -n argocd -l managed-by=atlas-operator

# Monitor resource usage
kubectl top pods -n atlas
```

## Troubleshooting

### Common Issues

1. **Database Connection Failed**
   ```bash
   # Check database credentials
   kubectl get secret atlas-db-credentials -n atlas -o yaml

   # Test connection manually
   psql "${DATABASE_URL}"
   ```

2. **ArgoCD Permission Denied**
   ```bash
   # Check RBAC
   kubectl describe clusterrole atlas-operator
   kubectl describe clusterrolebinding atlas-operator
   ```

3. **Applications Not Created**
   ```bash
   # Check operator logs
   kubectl logs -n atlas -l app=atlas-operator --tail=100

   # Verify ArgoCD is running
   kubectl get pods -n argocd
   ```

## Next Steps

1. **Add Metrics**
   - Integrate Prometheus metrics
   - Create Grafana dashboards

2. **Enhance Error Handling**
   - Implement exponential backoff
   - Add circuit breaker pattern

3. **Add Webhook Support**
   - Listen for database changes via webhooks
   - Reduce reconciliation interval

4. **Implement CRDs**
   - Create UserApplication custom resource
   - Add validation webhooks

5. **Multi-tenancy Support**
   - Support multiple organizations
   - Implement resource quotas per user