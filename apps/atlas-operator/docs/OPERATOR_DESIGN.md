# Atlas Kubernetes Operator - Design Document

## Executive Summary

This document outlines the design and implementation plan for a Kubernetes Operator that automatically manages ArgoCD Applications based on user membership in a Postgres database. The operator will monitor organization users, create ArgoCD Applications for new users, and clean up applications when users are removed.

## Architecture Overview

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Kubernetes Cluster                              │
│                                                                       │
│  ┌──────────────────────────────┐    ┌──────────────────────────┐   │
│  │  Atlas Operator              │    │  ArgoCD Namespace        │   │
│  │                               │    │                          │   │
│  │  ┌────────────────────┐      │    │  ┌──────────────────┐   │   │
│  │  │  Controller Loop    │      │────┼──▶ ArgoCD Apps      │   │   │
│  │  └────────────────────┘      │    │  └──────────────────┘   │   │
│  │           │                   │    │                          │   │
│  │           ▼                   │    └──────────────────────────┘   │
│  │  ┌────────────────────┐      │                                    │
│  │  │  DB Watcher        │      │                                    │
│  │  └────────────────────┘      │                                    │
│  └──────────────────────────────┘                                    │
│              │                                                        │
└──────────────┼────────────────────────────────────────────────────┘
                │
                ▼
        ┌─────────────────┐
        │  Postgres DB    │
        │  (Supabase)     │
        └─────────────────┘
```

### Core Components

1. **Controller**: Main reconciliation loop that manages the operator lifecycle
2. **Database Watcher**: Monitors Postgres for user changes
3. **ArgoCD Manager**: Creates and deletes ArgoCD Applications
4. **Configuration Manager**: Handles environment variables and secrets

## Detailed Design

### 1. Database Schema Understanding

**Table to Monitor:**
- `organization_user`: Links users to organizations with roles - this is the only table we need to monitor

**Multi-Organization Support:**
The operator supports monitoring multiple organizations simultaneously by providing a comma-separated list of organization IDs. The database queries use SQL `IN` clauses to efficiently retrieve users from all configured organizations in a single query.

**Key Fields in `organization_user`:**
- `organization_id`: Organization identifier
- `user_id`: User identifier
- `roles`: Array of user roles (e.g., org_owner, org_admin, org_member)
- `created_at` / `updated_at`: Timestamps for tracking changes

**Note**: We only monitor the `organization_user` table because:
- User addition to an organization triggers Atlas installation creation
- User removal from an organization triggers Atlas installation deletion
- User details from the `user` table are not needed for managing ArgoCD applications

### 2. Operator Workflow

#### Initialization Phase
1. Load environment configuration (.env file)
2. Establish database connection
3. Connect to Kubernetes API
4. Initialize state tracking (existing users and applications)

#### Reconciliation Loop
```
Every 30 seconds (configurable):
1. Query database for current organization users (across all configured orgs)
2. Get list of existing ArgoCD Applications
3. Compare current state with desired state
4. Create applications for new users
5. Delete applications for removed users
6. Update internal state
```

**Note**: When multiple organizations are configured, the operator queries all organizations in a single database call using SQL `IN` clause for optimal performance.

### 3. ArgoCD Application Specification

For each user, the operator will create an Application with:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: atlas-user-<user_id>  # e.g., atlas-user-6bd8e78LgpQzW
  namespace: argocd
  labels:
    managed-by: atlas-operator
    user-id: <user_id>
    organization-id: <organization_id>
spec:
  destination:
    namespace: atlas  # Single namespace for all users
    server: https://kubernetes.default.svc
  project: default
  source:
    path: atlas/overlays/<environment>  # e.g., atlas/overlays/sandbox or atlas/overlays/production
    repoURL: git@github.com:tempestteam/tempest-kustomize.git
    targetRevision: HEAD
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
    - CreateNamespace=true
```

### 4. Configuration Management

**Environment Variables (.env)**:
```env
# Database Configuration
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
ORGANIZATION_ID=your-org-id-1,your-org-id-2  # Comma-separated list for multiple orgs

# Operator Configuration
RECONCILIATION_INTERVAL=30s
NAMESPACE=atlas
ARGOCD_NAMESPACE=argocd
ENVIRONMENT=sandbox  # Environment (sandbox/production)

# ArgoCD Repository Configuration
GIT_REPO_URL=git@github.com:tempestteam/tempest-kustomize.git
GIT_TARGET_REVISION=HEAD

# Logging
LOG_LEVEL=info
```

### 5. State Management

The operator will maintain internal state to track:
- Current users in the organization
- Existing ArgoCD Applications
- Last reconciliation timestamp
- Error states and retry counts

## Implementation Roadmap

### Phase 1: Core Operator Development

1. **Project Setup**
   - Initialize Go module
   - Set up Kubebuilder/Operator SDK project structure
   - Configure dependencies (client-go, controller-runtime, pq)

2. **Database Integration**
   - Implement Postgres connection pool
   - Create user query functions
   - Implement change detection logic

3. **Basic Controller**
   - Implement reconciliation loop
   - Add state tracking
   - Error handling and retry logic

### Phase 2: ArgoCD Integration

1. **ArgoCD Client**
   - Implement ArgoCD Application creation
   - Add Application deletion logic
   - Handle Application updates

2. **Template System**
   - Create configurable Application templates
   - Support for different user roles
   - Single namespace deployment (atlas)

### Phase 3: Production Readiness

1. **Observability**
   - Prometheus metrics (reconciliation time, user count, error rate)
   - Structured logging
   - Health check endpoints

2. **Security**
   - RBAC configuration
   - Secret management
   - Network policies

3. **Testing**
   - Unit tests
   - Integration tests
   - End-to-end tests

### Phase 4: Deployment and Operations

1. **Deployment Artifacts**
   - Docker image
   - Helm chart
   - Kustomize manifests

2. **Documentation**
   - Operator user guide
   - Troubleshooting guide
   - API documentation

## Technical Stack

### Core Technologies
- **Language**: Go 1.25.3
- **Kubernetes Libraries**:
  - client-go v0.33.x (check latest at github.com/kubernetes/client-go/tags)
  - controller-runtime v0.22.3 (latest release)
- **Database**:
  - github.com/jmoiron/sqlx (SQL extensions)
  - github.com/lib/pq (PostgreSQL driver)
- **Configuration**:
  - github.com/joho/godotenv (for .env file loading)
  - github.com/caarlos0/env/v11 (for struct-based env parsing)
- **Build Tools**: Docker, Make

### Framework Choice
- **Operator SDK v1.41.1** for operator scaffolding (REQUIRED - provides better abstractions than raw Kubebuilder)
- **Kustomize** for configuration management (no Helm)
- **No init containers** - .env loaded directly from mounted volume

## Security Considerations

1. **Database Security**
   - Use connection pooling with SSL
   - Load credentials from .env file (mounted as volume)
   - .env file delivered securely via Kustomize configuration
   - Implement least privilege access

2. **Kubernetes Security**
   - RBAC with minimal permissions
   - ServiceAccount for operator
   - Network policies for pod communication

3. **ArgoCD Security**
   - Limit operator permissions to Application management
   - Use separate projects for user applications
   - Consider resource management strategies for shared namespace

## Monitoring and Alerting

### Key Metrics
- `atlas_operator_reconciliation_duration_seconds`: Time taken for reconciliation
- `atlas_operator_users_total`: Total number of users being managed
- `atlas_operator_applications_created_total`: Counter of created applications
- `atlas_operator_applications_deleted_total`: Counter of deleted applications
- `atlas_operator_errors_total`: Total errors by type

### Alerts
- High error rate (>5% of reconciliations failing)
- Long reconciliation time (>60s)
- Database connection failures
- ArgoCD API failures

## Error Handling

### Retry Strategy
- Exponential backoff for transient failures
- Maximum retry count: 5
- Circuit breaker for persistent failures

### Failure Scenarios
1. **Database Unavailable**: Continue with cached state, alert operators
2. **ArgoCD API Failure**: Retry with backoff, mark resources for retry
3. **Invalid User Data**: Skip user, log error, continue with others
4. **Resource Conflicts**: Use server-side apply with conflict resolution

## Testing Strategy

### Unit Tests
- Database query functions
- State management logic
- Template generation

### Integration Tests
- Database connection and queries
- Kubernetes API interactions
- ArgoCD Application lifecycle

### End-to-End Tests
- User addition flow
- User removal flow
- Bulk user changes
- Error recovery scenarios

## Performance Considerations

### Scalability
- Support for 1000+ users
- Batch processing for bulk changes
- Concurrent Application management

### Optimization
- Database connection pooling
- Caching of user state
- Rate limiting for API calls
- Pagination for large result sets

## Migration Path

### Rollout Strategy
1. Deploy operator in dry-run mode
2. Validate generated Applications
3. Enable creation for new users only
4. Migrate existing users gradually
5. Full production deployment

### Rollback Plan
1. Disable operator reconciliation
2. Preserve existing Applications
3. Manual management fallback
4. Data export for recovery

## Appendix

### A. Sample CRD (Optional Enhancement)

```yaml
apiVersion: atlas.tempest.io/v1alpha1
kind: UserApplication
metadata:
  name: user-6bd8e78LgpQzW
spec:
  userId: 6bd8e78LgpQzW
  organizationId: your-org-id
  role: org_member
  applicationTemplate:
    source:
      repoURL: git@github.com:tempestteam/tempest-kustomize.git
      path: atlas/overlays/sandbox  # Or production based on environment
      targetRevision: HEAD
  namespace: atlas
status:
  applicationName: atlas-user-6bd8e78LgpQzW
  syncStatus: Synced
  health: Healthy
  lastReconciled: 2025-10-28T20:00:00Z
```

### B. Deployment via Kustomize

```bash
#!/bin/bash
# deploy.sh - Deploy operator using Kustomize

# Navigate to tempest-kustomize repository
cd /path/to/tempest-kustomize

# Deploy to sandbox environment
# This will automatically:
# - Create the namespace
# - Configure RBAC
# - Deploy the operator with .env configuration
kubectl apply -k atlas-operator/overlays/sandbox

# Or deploy to production
kubectl apply -k atlas-operator/overlays/production

# Check deployment status
kubectl get all -n atlas

# View logs
kubectl logs -n atlas -l app=atlas-operator -f
```

### C. Monitoring Dashboard (Grafana)

Key panels:
- User count over time
- Application creation/deletion rate
- Reconciliation duration histogram
- Error rate by type
- Database query performance

## Next Steps

1. **Immediate Actions**
   - Review and approve design
   - Set up development environment
   - Create Git repository

2. **Short-term Goals**
   - Implement MVP with basic functionality
   - Deploy to development cluster
   - Gather feedback from stakeholders

3. **Long-term Vision**
   - Multi-organization support
   - Custom resource definitions
   - GitOps integration
   - Advanced RBAC per user role