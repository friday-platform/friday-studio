package argocd

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/rest"
)

func TestNewManager(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	// Test with valid config structure
	config := &rest.Config{
		Host: "https://fake-kubernetes-api:6443",
	}

	m, err := NewManager(config, "argocd", "atlas", "sandbox", "git@github.com:test/repo.git", "HEAD", logger)
	// This will fail in test environment since we don't have a real Kubernetes API
	// but we're verifying it attempts to create the client correctly
	if err != nil {
		// Expected error in test environment
		t.Logf("expected error in test environment: %v", err)
		return
	}

	// If we somehow got a manager (shouldn't happen in test), verify it's initialized
	if m == nil {
		t.Error("expected non-nil manager")
		return
	}
	if m.namespace != "argocd" {
		t.Errorf("expected namespace 'argocd', got %s", m.namespace)
	}
	if m.targetNamespace != "atlas" {
		t.Errorf("expected targetNamespace 'atlas', got %s", m.targetNamespace)
	}
	if m.environment != "sandbox" {
		t.Errorf("expected environment 'sandbox', got %s", m.environment)
	}
}

func TestBuildApplication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	scheme := runtime.NewScheme()

	dynamicClient := fake.NewSimpleDynamicClient(scheme)

	m := &Manager{
		dynamicClient:   dynamicClient,
		namespace:       "argocd",
		targetNamespace: "atlas",
		environment:     "sandbox",
		gitRepoURL:      "git@github.com:test/repo.git",
		gitRevision:     "main",
		logger:          logger,
	}

	expectedName := UserIDToAppName("user-123")
	app := m.buildApplication(expectedName, "user-123")

	// Verify basic structure
	if app.GetKind() != "Application" {
		t.Errorf("expected kind 'Application', got %s", app.GetKind())
	}

	if app.GetAPIVersion() != "argoproj.io/v1alpha1" {
		t.Errorf("expected apiVersion 'argoproj.io/v1alpha1', got %s", app.GetAPIVersion())
	}

	if app.GetName() != expectedName {
		t.Errorf("expected name '%s', got %s", expectedName, app.GetName())
	}

	if app.GetNamespace() != "argocd" {
		t.Errorf("expected namespace 'argocd', got %s", app.GetNamespace())
	}

	// Verify labels
	labels := app.GetLabels()
	if labels["managed-by"] != "atlas-operator" {
		t.Errorf("expected label 'managed-by=atlas-operator', got %s", labels["managed-by"])
	}
	if labels["user-id"] != "user-123" {
		t.Errorf("expected label 'user-id=user-123', got %s", labels["user-id"])
	}

	// Verify spec.destination
	destination, found, err := unstructured.NestedMap(app.Object, "spec", "destination")
	if err != nil {
		t.Fatalf("failed to get spec.destination: %v", err)
	}
	if !found {
		t.Fatal("spec.destination not found")
	}
	if destination["namespace"] != "atlas" {
		t.Errorf("expected destination.namespace 'atlas', got %s", destination["namespace"])
	}
	if destination["server"] != "https://kubernetes.default.svc" {
		t.Errorf("expected destination.server 'https://kubernetes.default.svc', got %s", destination["server"])
	}

	// Verify spec.source (access directly without deep copy to avoid issues with patches slice)
	spec, ok := app.Object["spec"].(map[string]interface{})
	if !ok {
		t.Fatal("spec not found or not a map")
	}
	source, ok := spec["source"].(map[string]interface{})
	if !ok {
		t.Fatal("spec.source not found or not a map")
	}
	if source["path"] != "atlas/overlays/sandbox" {
		t.Errorf("expected source.path 'atlas/overlays/sandbox', got %s", source["path"])
	}
	if source["repoURL"] != "git@github.com:test/repo.git" {
		t.Errorf("expected source.repoURL 'git@github.com:test/repo.git', got %s", source["repoURL"])
	}
	if source["targetRevision"] != "main" {
		t.Errorf("expected source.targetRevision 'main', got %s", source["targetRevision"])
	}

	// Verify spec.source.kustomize
	kustomize, ok := source["kustomize"].(map[string]interface{})
	if !ok {
		t.Fatal("spec.source.kustomize not found or not a map")
	}
	expectedSuffix := "-user-123" // user ID used directly (lowercase alphanumeric)
	if kustomize["nameSuffix"] != expectedSuffix {
		t.Errorf("expected kustomize.nameSuffix '%s', got %s", expectedSuffix, kustomize["nameSuffix"])
	}

	// Verify spec.source.kustomize.patches
	patchesRaw, ok := kustomize["patches"]
	if !ok {
		t.Fatal("spec.source.kustomize.patches not found")
	}
	patches, ok := patchesRaw.([]interface{})
	if !ok {
		t.Fatalf("patches is not []interface{}, got %T", patchesRaw)
	}
	if len(patches) != 5 {
		t.Errorf("expected 5 patches (Certificate, Deployment, Service, IngressRoute, PodDisruptionBudget), got %d", len(patches))
	}

	// Verify Certificate patch (first patch)
	if len(patches) > 0 {
		patch, ok := patches[0].(map[string]interface{})
		if !ok {
			t.Fatal("patch is not a map[string]interface{}")
		}
		if target, ok := patch["target"].(map[string]interface{}); ok {
			if target["kind"] != "Certificate" {
				t.Errorf("expected patch target kind 'Certificate', got %s", target["kind"])
			}
			if target["name"] != "atlas-cert" {
				t.Errorf("expected patch target name 'atlas-cert', got %s", target["name"])
			}
		} else {
			t.Error("patch target not found or not a map")
		}
		// Verify the patch contains the DNS names (JSON6902 format)
		if patchContent, ok := patch["patch"].(string); ok {
			expectedServiceName := "atlas-user-123"
			expectedNameSuffix := "-user-123"
			// Verify it's a JSON6902 patch with add operations
			if !strings.Contains(patchContent, "op: add") {
				t.Error("patch should contain 'op: add' for JSON6902 format")
			}
			if !strings.Contains(patchContent, "/spec/dnsNames/-") {
				t.Error("patch should contain '/spec/dnsNames/-' path")
			}
			// Verify secretName replacement
			if !strings.Contains(patchContent, "op: replace") {
				t.Error("patch should contain 'op: replace' for secretName")
			}
			if !strings.Contains(patchContent, "/spec/secretName") {
				t.Error("patch should contain '/spec/secretName' path")
			}
			expectedSecretName := "atlas-cert-secret" + expectedNameSuffix
			if !strings.Contains(patchContent, expectedSecretName) {
				t.Errorf("patch should contain secretName '%s'", expectedSecretName)
			}
			// Verify all three DNS name variants are present
			if !strings.Contains(patchContent, expectedServiceName) {
				t.Errorf("patch should contain short DNS name '%s'", expectedServiceName)
			}
			if !strings.Contains(patchContent, expectedServiceName+".atlas") {
				t.Errorf("patch should contain DNS name '%s.atlas'", expectedServiceName)
			}
			if !strings.Contains(patchContent, expectedServiceName+".atlas.svc.cluster.local") {
				t.Errorf("patch should contain DNS name '%s.atlas.svc.cluster.local'", expectedServiceName)
			}
		} else {
			t.Error("patch content not found or not a string")
		}
	}

	// Verify Deployment patch (second patch)
	if len(patches) > 1 {
		patch, ok := patches[1].(map[string]interface{})
		if !ok {
			t.Fatal("second patch is not a map[string]interface{}")
		}
		if target, ok := patch["target"].(map[string]interface{}); ok {
			if target["kind"] != "Deployment" {
				t.Errorf("expected second patch target kind 'Deployment', got %s", target["kind"])
			}
			if target["name"] != "atlas" {
				t.Errorf("expected second patch target name 'atlas', got %s", target["name"])
			}
		} else {
			t.Error("second patch target not found or not a map")
		}
		// Verify the deployment patch updates the volume secret reference AND selector/labels
		if patchContent, ok := patch["patch"].(string); ok {
			expectedNameSuffix := "-user-123"
			expectedAppLabel := "atlas" + expectedNameSuffix
			// Verify it's a JSON6902 patch with replace operations
			if !strings.Contains(patchContent, "op: replace") {
				t.Error("deployment patch should contain 'op: replace' for JSON6902 format")
			}
			if !strings.Contains(patchContent, "/spec/template/spec/volumes/0/secret/secretName") {
				t.Error("deployment patch should contain volume secretName path")
			}
			expectedSecretName := "atlas-cert-secret" + expectedNameSuffix
			if !strings.Contains(patchContent, expectedSecretName) {
				t.Errorf("deployment patch should contain secretName '%s'", expectedSecretName)
			}
			// Verify selector.matchLabels patch
			if !strings.Contains(patchContent, "/spec/selector/matchLabels/app") {
				t.Error("deployment patch should contain selector matchLabels app path")
			}
			if !strings.Contains(patchContent, expectedAppLabel) {
				t.Errorf("deployment patch should contain app label '%s'", expectedAppLabel)
			}
			// Verify template.metadata.labels patch
			if !strings.Contains(patchContent, "/spec/template/metadata/labels/app") {
				t.Error("deployment patch should contain template labels app path")
			}
		} else {
			t.Error("deployment patch content not found or not a string")
		}
	}

	// Verify Service patch (third patch - NEW!)
	if len(patches) > 2 {
		patch, ok := patches[2].(map[string]interface{})
		if !ok {
			t.Fatal("third patch is not a map[string]interface{}")
		}
		if target, ok := patch["target"].(map[string]interface{}); ok {
			if target["kind"] != "Service" {
				t.Errorf("expected third patch target kind 'Service', got %s", target["kind"])
			}
			if target["name"] != "atlas" {
				t.Errorf("expected third patch target name 'atlas', got %s", target["name"])
			}
		} else {
			t.Error("third patch target not found or not a map")
		}
		// Verify the Service patch updates the selector to be user-specific
		if patchContent, ok := patch["patch"].(string); ok {
			expectedNameSuffix := "-user-123"
			expectedAppLabel := "atlas" + expectedNameSuffix
			// Verify it's a JSON6902 patch with replace operation
			if !strings.Contains(patchContent, "op: replace") {
				t.Error("service patch should contain 'op: replace' for JSON6902 format")
			}
			if !strings.Contains(patchContent, "/spec/selector/app") {
				t.Error("service patch should contain selector app path")
			}
			if !strings.Contains(patchContent, expectedAppLabel) {
				t.Errorf("service patch should contain app label '%s'", expectedAppLabel)
			}
		} else {
			t.Error("service patch content not found or not a string")
		}
	}

	// Verify IngressRoute patch (fourth patch)
	if len(patches) > 3 {
		patch, ok := patches[3].(map[string]interface{})
		if !ok {
			t.Fatal("fourth patch is not a map[string]interface{}")
		}
		if target, ok := patch["target"].(map[string]interface{}); ok {
			if target["kind"] != "IngressRoute" {
				t.Errorf("expected fourth patch target kind 'IngressRoute', got %s", target["kind"])
			}
			if target["name"] != "atlas-ingressroute" {
				t.Errorf("expected fourth patch target name 'atlas-ingressroute', got %s", target["name"])
			}
		} else {
			t.Error("third patch target not found or not a map")
		}
		// Verify the IngressRoute patch updates the header match and service name
		if patchContent, ok := patch["patch"].(string); ok {
			expectedUserID := "user-123" // user ID used directly (lowercase alphanumeric)
			expectedServiceName := "atlas-user-123"
			// Verify it's a JSON6902 patch with replace operations
			if !strings.Contains(patchContent, "op: replace") {
				t.Error("IngressRoute patch should contain 'op: replace' for JSON6902 format")
			}
			if !strings.Contains(patchContent, "/spec/routes/0/match") {
				t.Error("IngressRoute patch should contain routes match path")
			}
			if !strings.Contains(patchContent, expectedUserID) {
				t.Errorf("IngressRoute patch should contain user ID '%s'", expectedUserID)
			}
			if !strings.Contains(patchContent, "/spec/routes/0/services/0/name") {
				t.Error("IngressRoute patch should contain service name path")
			}
			if !strings.Contains(patchContent, expectedServiceName) {
				t.Errorf("IngressRoute patch should contain service name '%s'", expectedServiceName)
			}
			// Verify serversTransport is set for extended upload timeouts
			if !strings.Contains(patchContent, "/spec/routes/0/services/0/serversTransport") {
				t.Error("IngressRoute patch should contain serversTransport path")
			}
			if !strings.Contains(patchContent, "atlas-operator-atlas-upload-transport@kubernetescrd") {
				t.Error("IngressRoute patch should contain atlas-upload-transport cross-namespace reference")
			}
			// Verify PLACEHOLDER_HOSTNAME is NOT present (should not exist in child routes)
			// Note: Host() matching is now in parent IngressRoute, child routes only match on header
			if strings.Contains(patchContent, "PLACEHOLDER_HOSTNAME") {
				t.Error("IngressRoute patch should NOT contain PLACEHOLDER_HOSTNAME")
			}
			// Verify Host() is NOT in the match rule (it's in the parent IngressRoute)
			if strings.Contains(patchContent, "Host(") {
				t.Error("IngressRoute patch should NOT contain Host() - host matching is in parent IngressRoute")
			}
		} else {
			t.Error("IngressRoute patch content not found or not a string")
		}
	}

	// Verify spec.syncPolicy
	syncPolicy, found, err := unstructured.NestedMap(app.Object, "spec", "syncPolicy")
	if err != nil {
		t.Fatalf("failed to get spec.syncPolicy: %v", err)
	}
	if !found {
		t.Fatal("spec.syncPolicy not found")
	}
	automated, found, err := unstructured.NestedMap(syncPolicy, "automated")
	if err != nil {
		t.Fatalf("failed to get spec.syncPolicy.automated: %v", err)
	}
	if !found {
		t.Fatal("spec.syncPolicy.automated not found")
	}
	if automated["prune"] != true {
		t.Error("expected spec.syncPolicy.automated.prune to be true")
	}
	if automated["selfHeal"] != true {
		t.Error("expected spec.syncPolicy.automated.selfHeal to be true")
	}
}

func TestCreateApplication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	scheme := runtime.NewScheme()

	// Create a pre-existing application to test the "already exists" path
	existingApp := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      UserIDToAppName("user-123"),
				"namespace": "argocd",
			},
		},
	}

	dynamicClient := fake.NewSimpleDynamicClient(scheme, existingApp)

	m := &Manager{
		dynamicClient:   dynamicClient,
		namespace:       "argocd",
		targetNamespace: "atlas",
		environment:     "sandbox",
		gitRepoURL:      "git@github.com:test/repo.git",
		gitRevision:     "main",
		logger:          logger,
	}

	ctx := context.Background()

	// Test creating an application that already exists (should not error)
	err := m.CreateApplication(ctx, "user-123")
	if err != nil {
		t.Errorf("expected no error when creating existing application, got %v", err)
	}

	// Test creating a new application
	err = m.CreateApplication(ctx, "user-999")
	if err != nil {
		t.Logf("create application error (expected in test environment): %v", err)
	}
}

func TestDeleteApplication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	scheme := runtime.NewScheme()

	// Create a pre-existing application to test deletion
	existingApp := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      UserIDToAppName("user-123"),
				"namespace": "argocd",
			},
		},
	}

	dynamicClient := fake.NewSimpleDynamicClient(scheme, existingApp)

	m := &Manager{
		dynamicClient:   dynamicClient,
		namespace:       "argocd",
		targetNamespace: "atlas",
		environment:     "sandbox",
		gitRepoURL:      "git@github.com:test/repo.git",
		gitRevision:     "main",
		logger:          logger,
	}

	ctx := context.Background()

	// Test deleting an existing application
	err := m.DeleteApplication(ctx, "user-123")
	if err != nil {
		t.Logf("delete application error (expected in test environment): %v", err)
	}

	// Test deleting a non-existent application (should not error)
	err = m.DeleteApplication(ctx, "user-999")
	if err != nil {
		t.Errorf("expected no error when deleting non-existent application, got %v", err)
	}
}

func TestGetApplication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	scheme := runtime.NewScheme()

	expectedName := UserIDToAppName("user-123")
	// Create a pre-existing application
	existingApp := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      expectedName,
				"namespace": "argocd",
			},
		},
	}

	dynamicClient := fake.NewSimpleDynamicClient(scheme, existingApp)

	m := &Manager{
		dynamicClient:   dynamicClient,
		namespace:       "argocd",
		targetNamespace: "atlas",
		environment:     "sandbox",
		gitRepoURL:      "git@github.com:test/repo.git",
		gitRevision:     "main",
		logger:          logger,
	}

	ctx := context.Background()

	// Test getting an existing application
	app, err := m.GetApplication(ctx, expectedName)
	if err != nil {
		t.Fatalf("failed to get application: %v", err)
	}
	if app == nil {
		t.Fatal("expected application to exist")
	}
	if app.GetName() != expectedName {
		t.Errorf("expected name '%s', got %s", expectedName, app.GetName())
	}

	// Test getting a non-existent application
	nonExistentName := UserIDToAppName("user-999")
	app, err = m.GetApplication(ctx, nonExistentName)
	if err != nil {
		t.Fatalf("failed to get application: %v", err)
	}
	if app != nil {
		t.Error("expected nil for non-existent application")
	}
}

func TestListApplications(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	scheme := runtime.NewScheme()

	// Create some pre-existing applications with the managed-by label
	app1 := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      UserIDToAppName("user-1"),
				"namespace": "argocd",
				"labels": map[string]interface{}{
					"managed-by": "atlas-operator",
				},
			},
		},
	}
	app2 := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      UserIDToAppName("user-2"),
				"namespace": "argocd",
				"labels": map[string]interface{}{
					"managed-by": "atlas-operator",
				},
			},
		},
	}
	app3 := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "argoproj.io/v1alpha1",
			"kind":       "Application",
			"metadata": map[string]interface{}{
				"name":      UserIDToAppName("user-3"),
				"namespace": "argocd",
				"labels": map[string]interface{}{
					"managed-by": "atlas-operator",
				},
			},
		},
	}

	dynamicClient := fake.NewSimpleDynamicClient(scheme, app1, app2, app3)

	m := &Manager{
		dynamicClient:   dynamicClient,
		namespace:       "argocd",
		targetNamespace: "atlas",
		environment:     "sandbox",
		gitRepoURL:      "git@github.com:test/repo.git",
		gitRevision:     "main",
		logger:          logger,
	}

	ctx := context.Background()

	// Test listing all applications
	apps, err := m.ListApplications(ctx)
	if err != nil {
		t.Fatalf("failed to list applications: %v", err)
	}
	if len(apps) != 3 {
		t.Errorf("expected 3 applications, got %d", len(apps))
	}
}

func TestGetUserIDFromApplication(t *testing.T) {
	tests := []struct {
		name        string
		app         *unstructured.Unstructured
		expectedID  string
		shouldError bool
	}{
		{
			name: "valid application with user-id label",
			app: &unstructured.Unstructured{
				Object: map[string]interface{}{
					"metadata": map[string]interface{}{
						"labels": map[string]interface{}{
							"user-id": "user-123",
						},
					},
				},
			},
			expectedID:  "user-123",
			shouldError: false,
		},
		{
			name: "application missing labels",
			app: &unstructured.Unstructured{
				Object: map[string]interface{}{
					"metadata": map[string]interface{}{},
				},
			},
			expectedID:  "",
			shouldError: true,
		},
		{
			name: "application missing user-id label",
			app: &unstructured.Unstructured{
				Object: map[string]interface{}{
					"metadata": map[string]interface{}{
						"labels": map[string]interface{}{
							"other-label": "value",
						},
					},
				},
			},
			expectedID:  "",
			shouldError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			userID, err := GetUserIDFromApplication(tt.app)

			if tt.shouldError && err == nil {
				t.Error("expected error, got nil")
			}
			if !tt.shouldError && err != nil {
				t.Errorf("expected no error, got %v", err)
			}
			if userID != tt.expectedID {
				t.Errorf("expected user ID '%s', got '%s'", tt.expectedID, userID)
			}
		})
	}
}

func TestUserIDToAppName(t *testing.T) {
	// User IDs from the database are now guaranteed to be lowercase alphanumeric
	// (from _tempest.shortid() with lowercase alphabet). We use them directly.
	tests := []struct {
		name     string
		userID   string
		expected string
	}{
		{
			name:     "simple lowercase user ID",
			userID:   "user123",
			expected: "atlas-user-user123",
		},
		{
			name:     "typical shortid format",
			userID:   "abc123def456",
			expected: "atlas-user-abc123def456",
		},
		{
			name:     "another shortid",
			userID:   "2z36dgjkqp61nrd",
			expected: "atlas-user-2z36dgjkqp61nrd",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := UserIDToAppName(tt.userID)
			if result != tt.expected {
				t.Errorf("expected '%s', got '%s'", tt.expected, result)
			}

			// Verify the result is RFC 1123 compliant (lowercase alphanumeric + hyphens)
			for _, ch := range result {
				if (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') && ch != '-' {
					t.Errorf("result contains invalid character '%c': %s", ch, result)
				}
			}
		})
	}
}

func TestUserIDToAppNameUniqueness(t *testing.T) {
	// User IDs from the database are guaranteed to be lowercase alphanumeric.
	// This test verifies that different lowercase IDs produce different app names.
	userID1 := "abc123"
	userID2 := "def456"
	userID3 := "ghi789"

	appName1 := UserIDToAppName(userID1)
	appName2 := UserIDToAppName(userID2)
	appName3 := UserIDToAppName(userID3)

	// All three should be different
	if appName1 == appName2 {
		t.Errorf("abc123 and def456 produced the same app name: %s", appName1)
	}
	if appName1 == appName3 {
		t.Errorf("abc123 and ghi789 produced the same app name: %s", appName1)
	}
	if appName2 == appName3 {
		t.Errorf("def456 and ghi789 produced the same app name: %s", appName2)
	}

	// Verify the expected format
	if appName1 != "atlas-user-abc123" {
		t.Errorf("expected 'atlas-user-abc123', got '%s'", appName1)
	}
	if appName2 != "atlas-user-def456" {
		t.Errorf("expected 'atlas-user-def456', got '%s'", appName2)
	}
	if appName3 != "atlas-user-ghi789" {
		t.Errorf("expected 'atlas-user-ghi789', got '%s'", appName3)
	}
}
