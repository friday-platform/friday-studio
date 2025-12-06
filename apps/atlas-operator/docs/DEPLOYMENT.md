# Atlas Operator - Deployment Guide

This guide explains how to build and deploy the Atlas Operator to your Kubernetes cluster.

## Security Warning

**NEVER commit real credentials to version control.** All examples in this guide use placeholder values. Always:
- Store actual secrets in Google Secret Manager
- Use placeholder values in documentation and example configs
- Rotate credentials immediately if accidentally exposed

## Prerequisites

- Access to Google Secret Manager (GSM) for storing secrets
- Kubernetes cluster with ArgoCD installed
- Docker for building images
- `gcloud` CLI configured
- kubectl access to the target cluster

## 1. Set up Secrets in Google Secret Manager

First, create the environment configuration in GSM.

**Multi-Organization Support**: You can monitor multiple organizations by providing a comma-separated list of organization IDs (e.g., `org1,org2,org3`). The operator will query all organizations in a single efficient database call.

### For Sandbox Environment

```bash
# Create the secret content (ORGANIZATION_ID can be comma-separated for multiple orgs)
cat > /tmp/atlas-operator-env <<EOF
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD_HERE@your-db-host.supabase.co:5432/postgres
ORGANIZATION_ID=your-org-id-1,your-org-id-2
GIT_REPO_URL=git@github.com:tempestteam/tempest-kustomize.git
GIT_TARGET_REVISION=HEAD
RECONCILIATION_INTERVAL=30s
ARGOCD_NAMESPACE=argocd
ENVIRONMENT=sandbox
LOG_LEVEL=info
HEALTH_CHECK_PORT=8080
METRICS_PORT=9090
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8082
WEBHOOK_TOKEN=your-secure-webhook-token
EOF

# Create the secret in GSM
gcloud secrets create atlas-operator-env \
  --project=tempest-sandbox \
  --data-file=/tmp/atlas-operator-env

# Clean up
rm /tmp/atlas-operator-env
```

### For Production Environment

```bash
# Create the secret content (use production database)
cat > /tmp/atlas-operator-env <<EOF
DATABASE_URL=postgresql://postgres:PRODUCTION_PASSWORD@production-db.example.com:5432/postgres
ORGANIZATION_ID=your-org-id
GIT_REPO_URL=git@github.com:tempestteam/tempest-kustomize.git
GIT_TARGET_REVISION=HEAD
RECONCILIATION_INTERVAL=30s
ARGOCD_NAMESPACE=argocd
ENVIRONMENT=production
LOG_LEVEL=info
HEALTH_CHECK_PORT=8080
METRICS_PORT=9090
EOF

# Create the secret in GSM
gcloud secrets create atlas-operator-env \
  --project=tempest-production \
  --data-file=/tmp/atlas-operator-env

# Clean up
rm /tmp/atlas-operator-env
```

## 2. Build and Push Docker Image

### For Sandbox

```bash
# Build the image
make docker-build ENV=sandbox

# Push to the registry
make docker-push ENV=sandbox
```

### For Production

```bash
# Build the image
make docker-build ENV=production

# Push to the registry
make docker-push ENV=production
```

## 3. Deploy Using Kustomize

All Kustomize manifests are maintained in the `tempest-kustomize` repository at `tempest-kustomize/atlas-operator/`.

### Deploy to Sandbox

```bash
# Navigate to tempest-kustomize repository
cd /path/to/tempest-kustomize

# Apply the configuration
kubectl apply -k atlas-operator/overlays/sandbox

# Verify deployment
kubectl get all -n atlas
```

### Deploy to Production

```bash
# Navigate to tempest-kustomize repository
cd /path/to/tempest-kustomize

# Apply the configuration
kubectl apply -k atlas-operator/overlays/production

# Verify deployment
kubectl get all -n atlas
```

## 4. Verify Deployment

### Check Operator Status

```bash
# Check pods are running
kubectl get pods -n atlas

# Check logs
kubectl logs -n atlas -l app=atlas-operator -f

# Check health endpoint
kubectl port-forward -n atlas svc/atlas-operator-metrics 8080:8080
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

### Check ArgoCD Applications

```bash
# List applications created by the operator
kubectl get applications -n argocd -l managed-by=atlas-operator

# Check a specific application
kubectl describe application -n argocd atlas-user-<user-id>
```

### Check Metrics

```bash
# Port forward to metrics endpoint
kubectl port-forward -n atlas svc/atlas-operator-metrics 9090:9090

# View metrics
curl http://localhost:9090/metrics | grep atlas_operator
```

## 5. Using the Webhook for Immediate Refresh

The operator exposes a webhook endpoint that allows external applications to trigger immediate reconciliation when users are created or updated, instead of waiting for the next periodic poll.

### Webhook Endpoint

```
POST /api/v1/refresh
```

### Authentication

If `WEBHOOK_TOKEN` is configured, requests must include a Bearer token:

```bash
curl -X POST http://atlas-operator-metrics:8082/api/v1/refresh \
  -H "Authorization: Bearer your-secure-webhook-token"
```

### Response

**Success (200 OK)**:
```json
{
  "status": "success",
  "message": "reconciliation triggered successfully"
}
```

**Error (401/500)**:
```json
{
  "status": "error",
  "message": "error description"
}
```

### Example: Triggering from Another Application

```go
import (
    "net/http"
)

func notifyAtlasOperator() error {
    req, _ := http.NewRequest("POST",
        "http://atlas-operator-metrics.atlas.svc.cluster.local:8082/api/v1/refresh",
        nil)

    req.Header.Set("Authorization", "Bearer "+os.Getenv("WEBHOOK_TOKEN"))

    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("webhook failed with status: %d", resp.StatusCode)
    }

    return nil
}
```

## 6. Troubleshooting

### Common Issues

1. **Operator not starting**
   - Check GSM secret exists: `gcloud secrets describe atlas-operator-env --project=tempest-sandbox`
   - Check init container logs: `kubectl logs -n atlas <pod-name> -c secrets`
   - Verify service account permissions for GSM access

2. **Database connection issues**
   - Check DATABASE_URL in GSM secret
   - Verify network connectivity to database
   - Check operator logs for connection errors

3. **ArgoCD Applications not being created**
   - Verify RBAC permissions: `kubectl auth can-i create applications -n argocd --as=system:serviceaccount:atlas:atlas-operator-manager`
   - Check ArgoCD is installed and running
   - Verify GitOps repository access

### Useful Commands

```bash
# Restart the operator
make restart

# View operator status
make status

# Follow logs
make logs

# Delete deployment
kubectl delete -k atlas-operator/overlays/sandbox
```

## 7. Monitoring

The operator exposes the following Prometheus metrics:

- `atlas_operator_reconciliation_duration_seconds` - Reconciliation time histogram
- `atlas_operator_users_total` - Total users being managed
- `atlas_operator_applications_created_total` - Applications created counter
- `atlas_operator_applications_deleted_total` - Applications deleted counter
- `atlas_operator_errors_total` - Errors by type

Configure Prometheus to scrape the metrics endpoint:

```yaml
- job_name: 'atlas-operator'
  kubernetes_sd_configs:
  - role: service
    namespaces:
      names:
      - atlas
  relabel_configs:
  - source_labels: [__meta_kubernetes_service_name]
    regex: atlas-operator-metrics
    action: keep
  - source_labels: [__meta_kubernetes_service_port_name]
    regex: metrics
    action: keep
```

## 8. Updates and Rollbacks

### Update the Operator

1. Build and push new image with appropriate tag
2. Update image tag in Kustomize overlay
3. Apply the changes: `kubectl apply -k atlas-operator/overlays/<environment>`
4. Monitor rollout: `kubectl rollout status deployment/atlas-operator-manager -n atlas`

### Rollback

```bash
# View rollout history
kubectl rollout history deployment/atlas-operator-manager -n atlas

# Rollback to previous version
kubectl rollout undo deployment/atlas-operator-manager -n atlas

# Rollback to specific revision
kubectl rollout undo deployment/atlas-operator-manager -n atlas --to-revision=2
```

## 9. Security Considerations

- The operator runs as non-root user (UID 65534, GID 266)
- Secrets are stored in Google Secret Manager, not in Kubernetes
- Init container fetches secrets at runtime
- Secrets are stored in memory-backed emptyDir volume
- All containers have read-only root filesystem
- Network policies can be added to restrict communication

## Next Steps

- Set up monitoring dashboards in Grafana
- Configure alerting rules in Prometheus
- Implement backup and disaster recovery procedures
- Document runbooks for common operational tasks