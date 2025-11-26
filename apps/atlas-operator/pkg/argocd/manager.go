package argocd

import (
	"context"
	"fmt"
	"log/slog"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

// Manager handles ArgoCD Application lifecycle.
type Manager struct {
	dynamicClient   dynamic.Interface
	namespace       string
	targetNamespace string
	environment     string
	gitRepoURL      string
	gitRevision     string
	logger          *slog.Logger
}

// ArgoCD Application GVR (Group Version Resource).
var applicationGVR = schema.GroupVersionResource{
	Group:    "argoproj.io",
	Version:  "v1alpha1",
	Resource: "applications",
}

// NewManager creates a new ArgoCD manager.
func NewManager(config *rest.Config, namespace, targetNamespace, environment, gitRepoURL, gitRevision string, logger *slog.Logger) (*Manager, error) {
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create dynamic client: %w", err)
	}

	logger.Info("Created ArgoCD manager",
		"namespace", namespace,
		"target_namespace", targetNamespace,
		"environment", environment,
		"git_repo_url", gitRepoURL,
		"git_revision", gitRevision,
	)

	return &Manager{
		dynamicClient:   dynamicClient,
		namespace:       namespace,
		targetNamespace: targetNamespace,
		environment:     environment,
		gitRepoURL:      gitRepoURL,
		gitRevision:     gitRevision,
		logger:          logger,
	}, nil
}

// UserIDToAppName converts a user ID to a Kubernetes-compliant application name.
// User IDs are already lowercase alphanumeric (from _tempest.shortid()), so they
// are RFC 1123 compliant and can be used directly without encoding.
func UserIDToAppName(userID string) string {
	return fmt.Sprintf("atlas-user-%s", userID)
}

// CreateApplication creates an ArgoCD Application for a user.
func (m *Manager) CreateApplication(ctx context.Context, userID string) error {
	appName := UserIDToAppName(userID)

	// Check if application already exists
	existing, err := m.GetApplication(ctx, appName)
	if err != nil {
		return fmt.Errorf("failed to check existing application: %w", err)
	}
	if existing != nil {
		m.logger.Info("Application already exists",
			"name", appName,
			"user_id", userID,
		)
		return nil
	}

	// Create the Application object
	app := m.buildApplication(appName, userID)

	// Create the Application
	_, err = m.dynamicClient.Resource(applicationGVR).Namespace(m.namespace).Create(ctx, app, metav1.CreateOptions{})
	if err != nil {
		m.logger.Error("Failed to create application",
			"error", err,
			"name", appName,
			"user_id", userID,
		)
		return fmt.Errorf("failed to create application: %w", err)
	}

	m.logger.Info("Created ArgoCD Application",
		"name", appName,
		"user_id", userID,
	)

	return nil
}

// DeleteApplication deletes an ArgoCD Application.
func (m *Manager) DeleteApplication(ctx context.Context, userID string) error {
	appName := UserIDToAppName(userID)

	// Check if application exists
	existing, err := m.GetApplication(ctx, appName)
	if err != nil {
		return fmt.Errorf("failed to check existing application: %w", err)
	}
	if existing == nil {
		m.logger.Info("Application does not exist",
			"name", appName,
			"user_id", userID,
		)
		return nil
	}

	// Delete the Application
	err = m.dynamicClient.Resource(applicationGVR).Namespace(m.namespace).Delete(ctx, appName, metav1.DeleteOptions{})
	if err != nil {
		m.logger.Error("Failed to delete application",
			"error", err,
			"name", appName,
			"user_id", userID,
		)
		return fmt.Errorf("failed to delete application: %w", err)
	}

	m.logger.Info("Deleted ArgoCD Application",
		"name", appName,
		"user_id", userID,
	)

	return nil
}

// GetApplication retrieves an ArgoCD Application.
func (m *Manager) GetApplication(ctx context.Context, name string) (*unstructured.Unstructured, error) {
	app, err := m.dynamicClient.Resource(applicationGVR).Namespace(m.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		// If not found, return nil without error
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	return app, nil
}

// ListApplications lists all ArgoCD Applications managed by this operator.
func (m *Manager) ListApplications(ctx context.Context) ([]*unstructured.Unstructured, error) {
	// List with label selector to get only operator-managed applications
	list, err := m.dynamicClient.Resource(applicationGVR).Namespace(m.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "managed-by=atlas-operator",
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list applications: %w", err)
	}

	apps := make([]*unstructured.Unstructured, len(list.Items))
	for i := range list.Items {
		apps[i] = &list.Items[i]
	}

	return apps, nil
}

// createPatchEntry creates a Kustomize patch entry with target selector.
func createPatchEntry(patch, kind, name string) map[string]interface{} {
	return map[string]interface{}{
		"patch": patch,
		"target": map[string]interface{}{
			"kind": kind,
			"name": name,
		},
	}
}

// buildApplication creates an unstructured Application object.
func (m *Manager) buildApplication(name, userID string) *unstructured.Unstructured {
	path := fmt.Sprintf("atlas/overlays/%s", m.environment)
	// User IDs are already lowercase alphanumeric (RFC 1123 compliant)
	nameSuffix := fmt.Sprintf("-%s", userID)
	// Service name after nameSuffix is applied
	serviceName := fmt.Sprintf("atlas%s", nameSuffix)

	// Patch certificate to add user-specific FQDN DNS names.
	// Kustomize can't do string concatenation, so we add complete DNS names here.
	// Using JSON6902 'add' operations to append to dnsNames array (not replace).
	// Also replace name and secretName to avoid ArgoCD conflicts.
	certPatch := fmt.Sprintf(`
- op: replace
  path: /metadata/name
  value: atlas-cert%s
- op: replace
  path: /spec/secretName
  value: atlas-cert-secret%s
- op: add
  path: /spec/dnsNames/-
  value: %s
- op: add
  path: /spec/dnsNames/-
  value: %s.atlas
- op: add
  path: /spec/dnsNames/-
  value: %s.atlas.svc.cluster.local
`, nameSuffix, nameSuffix, serviceName, serviceName, serviceName)

	// CRITICAL: Update deployment selector and pod labels to be user-specific.
	// This ensures each deployment only manages its own pods, preventing the
	// cross-user routing bug. Also updates the volume secretName reference.
	// Note: cert-volume is at index 0 - fragile if base deployment changes.
	// IMPORTANT: Add Replace=true,Force=true to handle immutable spec.selector field.
	// Replace=true alone uses `kubectl replace` which CANNOT modify immutable fields.
	// Force=true triggers `kubectl delete/create` which can handle immutable changes.
	// When changing from "app: atlas" to "app: atlas-<userID>", this combination allows
	// the deployment to be deleted and recreated with the new selector.
	deploymentPatch := fmt.Sprintf(`
- op: add
  path: /metadata/annotations/argocd.argoproj.io~1sync-options
  value: Replace=true,Force=true
- op: replace
  path: /spec/template/spec/volumes/0/secret/secretName
  value: atlas-cert-secret%s
- op: replace
  path: /spec/selector/matchLabels/app
  value: %s
- op: replace
  path: /spec/template/metadata/labels/app
  value: %s
`, nameSuffix, serviceName, serviceName)

	// CRITICAL: Service selector must match deployment's pod labels.
	// Without this patch, all services select ALL atlas pods (app: atlas)
	// causing random routing across all users' instances.
	servicePatch := fmt.Sprintf(`
- op: replace
  path: /spec/selector/app
  value: %s
`, serviceName)

	// Set IngressRoute match rules with user-specific header matching.
	// Note: Host() matching is in the parent IngressRoute, child routes only match on header.
	// The parent IngressRoute applies the extractuserid middleware before child routing.

	// API route match (route 0) - includes path prefix for API endpoints
	apiMatchRule := fmt.Sprintf("Header(`X-Atlas-User-ID`, `%s`) && (PathPrefix(`/api/`) || Path(`/health`) || PathPrefix(`/streams/`))", userID)

	// Default route match (route 1) for non-API traffic - header matching only
	defaultMatchRule := fmt.Sprintf("Header(`X-Atlas-User-ID`, `%s`)", userID)

	ingressRoutePatch := fmt.Sprintf(`
- op: replace
  path: /spec/routes/0/match
  value: %s
- op: replace
  path: /spec/routes/0/services/0/name
  value: %s
- op: replace
  path: /spec/routes/1/match
  value: %s
- op: replace
  path: /spec/routes/1/services/0/name
  value: %s
`, apiMatchRule, serviceName, defaultMatchRule, serviceName)

	// CRITICAL: PDB selector must match deployment's pod labels.
	// Without this patch, PDB uses old selector (app: atlas) which tries to protect
	// ALL atlas pods across all users, causing PDB calculation errors and Degraded status.
	pdbPatch := fmt.Sprintf(`
- op: replace
  path: /spec/selector/matchLabels/app
  value: %s
`, serviceName)

	app := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": m.namespace,
				"labels": map[string]interface{}{
					"managed-by": "atlas-operator",
					"user-id":    userID,
				},
			},
			"spec": map[string]interface{}{
				"destination": map[string]interface{}{
					"namespace": m.targetNamespace, // Single atlas namespace for all users
					"server":    "https://kubernetes.default.svc",
				},
				"project": "default",
				"source": map[string]interface{}{
					"path":           path,
					"repoURL":        m.gitRepoURL,
					"targetRevision": m.gitRevision,
					"kustomize": map[string]interface{}{
						"nameSuffix": nameSuffix,
						"patches": []interface{}{
							createPatchEntry(certPatch, "Certificate", "atlas-cert"),
							createPatchEntry(deploymentPatch, "Deployment", "atlas"),
							createPatchEntry(servicePatch, "Service", "atlas"),
							createPatchEntry(ingressRoutePatch, "IngressRoute", "atlas-ingressroute"),
							createPatchEntry(pdbPatch, "PodDisruptionBudget", "atlas-pdb"),
						},
					},
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

	return app
}

// GetUserIDFromApplication extracts the user ID from an Application's labels.
func GetUserIDFromApplication(app *unstructured.Unstructured) (string, error) {
	labels, found, err := unstructured.NestedStringMap(app.Object, "metadata", "labels")
	if err != nil {
		return "", fmt.Errorf("failed to get labels: %w", err)
	}
	if !found {
		return "", fmt.Errorf("no labels found")
	}

	userID, ok := labels["user-id"]
	if !ok {
		return "", fmt.Errorf("no user-id label found")
	}

	return userID, nil
}
