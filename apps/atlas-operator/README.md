# Atlas Kubernetes Operator

A Kubernetes Operator that automatically manages ArgoCD Applications based on organization user membership in a PostgreSQL database.

## Overview

The Atlas Operator monitors a PostgreSQL database for changes in organization user membership and automatically:
- Creates ArgoCD Applications for new users
- Removes ArgoCD Applications when users are deleted
- Manages Atlas deployments in a single namespace

## Documentation

- **[Design Document](docs/OPERATOR_DESIGN.md)** - Complete architectural design and system overview
- **[Implementation Guide](docs/IMPLEMENTATION_GUIDE.md)** - Step-by-step implementation with code examples
- **[Deployment Guide](docs/DEPLOYMENT.md)** - Production deployment instructions

## Key Features

- **Automated User Management**: Synchronizes database users with Kubernetes resources
- **Multi-Organization Support**: Monitor multiple organizations with comma-separated IDs
- **ArgoCD Integration**: Creates and manages ArgoCD Applications per user
- **Database Monitoring**: Polls PostgreSQL for user changes (30s default)
- **Webhook Support**: Trigger immediate reconciliation via HTTP webhook
- **Single Namespace Deployment**: All users share the atlas namespace
- **GitOps Ready**: Integrates with existing Kustomize/Helm workflows
- **Production Ready**: Includes health checks, metrics, and error handling

## Quick Start

1. **Prerequisites**
   - Kubernetes cluster with ArgoCD installed
   - Access to PostgreSQL database
   - Go 1.25.3 (for development)
   - Access to `tempest-kustomize` repository

2. **Configuration**
   The operator is configured via `.env` files in the `tempest-kustomize` repository:
   ```
   tempest-kustomize/atlas-operator/overlays/[environment]/.env
   ```

3. **Deploy**
   ```bash
   # From tempest-kustomize repository
   cd /path/to/tempest-kustomize

   # Deploy to sandbox
   kubectl apply -k atlas-operator/overlays/sandbox

   # Or deploy to production
   kubectl apply -k atlas-operator/overlays/production
   ```

   The Kustomize configuration will:
   - Create the `atlas` namespace (if not exists)
   - Set up RBAC permissions
   - Deploy the operator with environment-specific configuration
   - Mount the `.env` file via gsm-init container

## Architecture

```
Database (Postgres) → Operator → ArgoCD → User Applications
```

The operator runs a reconciliation loop every 30 seconds (configurable) to:
1. Query the database for current organization users (across all configured orgs)
2. List existing ArgoCD Applications
3. Create applications for new users
4. Delete applications for removed users

### Multi-Organization Support

Monitor multiple organizations by providing a comma-separated list:
```bash
ORGANIZATION_ID=org-id-1,org-id-2,org-id-3
```

The operator efficiently queries all organizations in a single database call using SQL `IN` clauses.

### Webhook for Immediate Refresh

Trigger immediate reconciliation when users are created/updated instead of waiting for the next poll:

```bash
# Without authentication
curl -X POST http://atlas-operator-service:8082/api/v1/refresh

# With authentication (recommended)
curl -X POST http://atlas-operator-service:8082/api/v1/refresh \
  -H "Authorization: Bearer your-webhook-token"
```

**Configuration**:
```bash
WEBHOOK_ENABLED=true              # Enable webhook (default: true)
WEBHOOK_PORT=8082                 # Webhook port (default: 8082)
WEBHOOK_TOKEN=your-secret-token   # Optional: Bearer token for authentication
```

## Development

```bash
# Run locally
make run

# Run tests
make test

# Build Docker image
make docker-build
```

## Configuration

**SECURITY NOTE**: Never commit real credentials to version control. Always use placeholder values in documentation and store actual secrets in Google Secret Manager.

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| DATABASE_URL | PostgreSQL connection string | Required |
| ORGANIZATION_ID | Comma-separated list of organization IDs to monitor (e.g., `org1,org2,org3`) | Required |
| RECONCILIATION_INTERVAL | How often to check for changes | 30s |
| ARGOCD_NAMESPACE | Namespace where ArgoCD is installed | argocd |
| GIT_REPO_URL | Repository with application manifests | Required |
| WEBHOOK_ENABLED | Enable webhook for on-demand refresh | true |
| WEBHOOK_PORT | Port for webhook server | 8082 |
| WEBHOOK_TOKEN | Bearer token for webhook authentication (optional) | - |
