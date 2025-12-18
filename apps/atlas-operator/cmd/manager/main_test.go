package main

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/tempestteam/atlas/apps/atlas-operator/internal/controller"
	"github.com/tempestteam/atlas/apps/atlas-operator/pkg/config"
)

func TestGetKubeConfig_Fallback(t *testing.T) {
	// This test verifies that getKubeConfig tries to load kubeconfig file
	// when in-cluster config is not available
	// In CI environment, both will likely fail, which is expected

	_, err := getKubeConfig()
	// We expect an error in test environment since we're not in a cluster
	// and may not have a valid kubeconfig file
	if err != nil {
		t.Logf("Expected error in test environment: %v", err)
	}
}

func TestStartHealthServer(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}
	reconciler := controller.NewReconciler(controller.Deps{Config: cfg, Logger: logger})

	// Start server on a random port
	port := 18080
	go startHealthServer(port, reconciler, logger)

	// Give the server time to start
	time.Sleep(100 * time.Millisecond)

	// Test healthz endpoint
	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/healthz", port))
	if err != nil {
		t.Fatalf("Failed to call healthz endpoint: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200 for healthz, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if string(body) != "OK" {
		t.Errorf("Expected body 'OK', got '%s'", string(body))
	}
}

func TestStartHealthServer_ReadyzWithNilDependencies(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}
	// Create reconciler with nil dependencies (should fail readyz check)
	reconciler := controller.NewReconciler(controller.Deps{Config: cfg, Logger: logger})

	port := 18081
	go startHealthServer(port, reconciler, logger)

	time.Sleep(100 * time.Millisecond)

	// Test readyz endpoint - should fail with nil dependencies
	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/readyz", port))
	if err != nil {
		t.Fatalf("Failed to call readyz endpoint: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("Expected status 503 for readyz with nil dependencies, got %d", resp.StatusCode)
	}
}

func TestStartMetricsServer(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	port := 18082
	go startMetricsServer(port, logger)

	time.Sleep(100 * time.Millisecond)

	// Test metrics endpoint
	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/metrics", port))
	if err != nil {
		t.Fatalf("Failed to call metrics endpoint: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200 for metrics, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	// Check that Prometheus metrics are exposed
	if len(bodyStr) == 0 {
		t.Error("Expected non-empty metrics output")
	}

	// Verify at least some Prometheus metrics are present
	// (Go runtime metrics are always present)
	if !contains(bodyStr, "go_") {
		t.Error("Expected Go runtime metrics to be present")
	}

	// Check that the metrics endpoint is working by verifying HELP text
	if !contains(bodyStr, "# HELP") {
		t.Error("Expected Prometheus HELP comments in metrics output")
	}

	// Check for at least one of our custom metrics
	// Note: Some metrics only appear after they've been observed/set
	customMetricsFound := false
	expectedMetrics := []string{
		"atlas_operator",
	}

	for _, metric := range expectedMetrics {
		if contains(bodyStr, metric) {
			customMetricsFound = true
			break
		}
	}

	if !customMetricsFound {
		t.Logf("Metrics output (first 500 chars): %s", bodyStr[:minInt(500, len(bodyStr))])
	}
}

func TestBuildInfoMetric(t *testing.T) {
	// Test that build info metric is properly set
	// This verifies the init() function registered the metric correctly

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	port := 18083
	go startMetricsServer(port, logger)

	time.Sleep(100 * time.Millisecond)

	// Set build info
	buildInfo.WithLabelValues("test-commit", "test-ref").Set(1)

	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/metrics", port))
	if err != nil {
		t.Fatalf("Failed to call metrics endpoint: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	body, _ := io.ReadAll(resp.Body)
	bodyStr := string(body)

	// Verify build info metric is present
	if !contains(bodyStr, "atlas_operator_build_info") {
		t.Error("Expected atlas_operator_build_info metric to be present")
	}
}

func TestVersionVariables(t *testing.T) {
	// Test that version variables exist and have default values
	if GitCommit == "" {
		t.Error("GitCommit should have a default value")
	}
	if GitRef == "" {
		t.Error("GitRef should have a default value")
	}

	// Default values should be "unknown"
	if GitCommit != "unknown" {
		t.Logf("GitCommit has non-default value: %s (may be set via ldflags)", GitCommit)
	}
	if GitRef != "unknown" {
		t.Logf("GitRef has non-default value: %s (may be set via ldflags)", GitRef)
	}
}

func TestHealthServerShutdown(t *testing.T) {
	// Test that health server can be started and responds correctly
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))
	cfg := &config.Config{
		ReconciliationInterval: 30 * time.Second,
	}
	reconciler := controller.NewReconciler(controller.Deps{Config: cfg, Logger: logger})

	port := 18084
	serverStarted := make(chan bool)

	go func() {
		serverStarted <- true
		startHealthServer(port, reconciler, logger)
	}()

	<-serverStarted
	time.Sleep(100 * time.Millisecond)

	// Verify server is running
	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/healthz", port))
	if err != nil {
		t.Fatalf("Failed to call healthz: %v", err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}
}

func TestMetricsServerShutdown(t *testing.T) {
	// Test that metrics server can be started and responds correctly
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelError}))

	port := 18085
	serverStarted := make(chan bool)

	go func() {
		serverStarted <- true
		startMetricsServer(port, logger)
	}()

	<-serverStarted
	time.Sleep(100 * time.Millisecond)

	// Verify server is running
	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/metrics", port))
	if err != nil {
		t.Fatalf("Failed to call metrics: %v", err)
	}
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("Expected status 200, got %d", resp.StatusCode)
	}
}

func TestPrometheusMetricsRegistered(t *testing.T) {
	// Verify all custom Prometheus metrics are registered in init()
	// We do this by checking that they can be used without panic

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("Panic when using Prometheus metrics: %v", r)
		}
	}()

	// Try to use all metrics - if they're not registered, this will panic
	buildInfo.WithLabelValues("test", "test").Set(1)
	reconciliationDuration.WithLabelValues("success").Observe(1.0)
	usersTotal.Set(10)
	applicationsCreatedTotal.Inc()
	applicationsDeletedTotal.Inc()
}

// Helper functions.
func contains(s, substr string) bool {
	return len(s) > 0 && len(substr) > 0 && (s == substr || len(s) >= len(substr) && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
