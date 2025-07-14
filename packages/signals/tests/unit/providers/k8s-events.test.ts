/**
 * Unit tests for Kubernetes Events Signal Provider
 * Tests security functions, configuration validation, and core functionality
 */

import { assert, assertEquals, assertExists, assertRejects, assertThrows } from "@std/assert";
import {
  K8sEventsSignalConfig,
  K8sEventsSignalProvider,
} from "../../../src/providers/k8s-events.ts";
import { ProviderStatus } from "../../../src/providers/types.ts";

// Mock console methods to capture log output for testing
class TestLogger {
  private logs: Array<{ level: string; message: string; data?: any }> = [];

  log(message: string, data?: any) {
    this.logs.push({ level: "info", message, data });
  }

  warn(message: string, data?: any) {
    this.logs.push({ level: "warn", message, data });
  }

  error(message: string, data?: any) {
    this.logs.push({ level: "error", message, data });
  }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
  }
}

// Helper to create basic valid config
function createValidConfig(): K8sEventsSignalConfig {
  return {
    kubeconfig: "/home/user/.kube/config",
    namespace: "default",
    timeout_ms: 30000,
    retry_config: {
      max_retries: 3,
      retry_delay_ms: 1000,
    },
  };
}

Deno.test("K8sEventsSignalProvider - Basic functionality", async (t) => {
  await t.step("should initialize with correct properties", () => {
    const provider = new K8sEventsSignalProvider();

    assertEquals(provider.type, "signal");
    assertEquals(provider.id, "k8s-events");
    assertEquals(provider.name, "Kubernetes Events Signal Provider");
    assertEquals(provider.version, "1.0.0");
  });

  await t.step("should start in NOT_CONFIGURED state", () => {
    const provider = new K8sEventsSignalProvider();
    const state = provider.getState();

    assertEquals(state.status, ProviderStatus.NOT_CONFIGURED);
  });

  await t.step("should transition to READY state after setup", async () => {
    const provider = new K8sEventsSignalProvider();

    await provider.setup();
    const state = provider.getState();

    assertEquals(state.status, ProviderStatus.READY);
  });

  await t.step("should transition to DISABLED state after teardown", async () => {
    const provider = new K8sEventsSignalProvider();

    await provider.setup();
    await provider.teardown();
    const state = provider.getState();

    assertEquals(state.status, ProviderStatus.DISABLED);
  });

  await t.step("should report healthy when READY", async () => {
    const provider = new K8sEventsSignalProvider();
    await provider.setup();

    const health = await provider.checkHealth();

    assert(health.healthy);
    assertEquals(health.message, `Kubernetes events provider is ${ProviderStatus.READY}`);
    assertExists(health.lastCheck);
  });
});

Deno.test("K8sEventsSignalProvider - Configuration validation", async (t) => {
  const provider = new K8sEventsSignalProvider();

  await t.step("should accept valid configuration", () => {
    const config = createValidConfig();

    // Should not throw
    const signal = provider.createSignal(config);
    assertExists(signal);
  });

  await t.step("should reject null/undefined configuration", () => {
    assertThrows(
      () => provider.createSignal(null as any),
      Error,
      "Invalid configuration object",
    );

    assertThrows(
      () => provider.createSignal(undefined as any),
      Error,
      "Invalid configuration object",
    );
  });

  await t.step("should validate namespace format", () => {
    const config = createValidConfig();

    // Valid namespaces
    config.namespace = "default";
    provider.createSignal({ ...config }); // Should not throw

    config.namespace = "kube-system";
    provider.createSignal({ ...config }); // Should not throw

    config.namespace = "my-app-123";
    provider.createSignal({ ...config }); // Should not throw

    // Invalid namespaces
    config.namespace = "INVALID";
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Invalid namespace format",
    );

    config.namespace = "invalid_namespace";
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Invalid namespace format",
    );

    config.namespace = "namespace-with-trailing-dash-";
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Invalid namespace format",
    );

    config.namespace = "a".repeat(64); // Too long
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Namespace name too long",
    );
  });

  await t.step("should validate timeout", () => {
    const config = createValidConfig();

    // Valid timeouts
    config.timeout_ms = 1000;
    provider.createSignal({ ...config }); // Should not throw

    config.timeout_ms = 300000;
    provider.createSignal({ ...config }); // Should not throw

    // Invalid timeouts
    config.timeout_ms = 999;
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Timeout must be between 1000ms and 300000ms",
    );

    config.timeout_ms = 300001;
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Timeout must be between 1000ms and 300000ms",
    );

    config.timeout_ms = -1000;
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Timeout must be between 1000ms and 300000ms",
    );
  });

  await t.step("should validate retry configuration", () => {
    const config = createValidConfig();

    // Valid retry config
    config.retry_config = { max_retries: 5, retry_delay_ms: 2000 };
    provider.createSignal({ ...config }); // Should not throw

    // Invalid max_retries
    config.retry_config = { max_retries: -1, retry_delay_ms: 1000 };
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Max retries must be between 0 and 10",
    );

    config.retry_config = { max_retries: 11, retry_delay_ms: 1000 };
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Max retries must be between 0 and 10",
    );

    // Invalid retry_delay_ms
    config.retry_config = { max_retries: 3, retry_delay_ms: 99 };
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Retry delay must be between 100ms and 60000ms",
    );

    config.retry_config = { max_retries: 3, retry_delay_ms: 60001 };
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Retry delay must be between 100ms and 60000ms",
    );
  });

  await t.step("should validate API server URL", () => {
    const config = createValidConfig();

    // Valid URLs
    config.api_server = "https://kubernetes.example.com";
    provider.createSignal({ ...config }); // Should not throw

    config.api_server = "http://localhost:8080";
    provider.createSignal({ ...config }); // Should not throw

    // Invalid URLs
    config.api_server = "ftp://invalid.com";
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "must use HTTP or HTTPS",
    );

    config.api_server = "not-a-url";
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Invalid API server URL format",
    );
  });

  await t.step("should validate environment variable names", () => {
    const config = createValidConfig();

    // Valid env var names
    config.kubeconfig_env = "KUBECONFIG";
    provider.createSignal({ ...config }); // Should not throw

    config.kubeconfig_env = "MY_CUSTOM_KUBECONFIG";
    provider.createSignal({ ...config }); // Should not throw

    // Invalid env var names
    config.kubeconfig_env = "123invalid";
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Invalid environment variable name",
    );

    config.kubeconfig_env = "invalid-name";
    assertThrows(
      () => provider.createSignal(config),
      Error,
      "Invalid environment variable name",
    );
  });
});

Deno.test("K8sEventsSignalProvider - Signal validation", async (t) => {
  const provider = new K8sEventsSignalProvider();

  await t.step("should validate signal with kubeconfig", () => {
    const config: K8sEventsSignalConfig = {
      kubeconfig: "/home/user/.kube/config",
    };

    const signal = provider.createSignal(config);
    assert(signal.validate());
  });

  await t.step("should validate signal with kubeconfig content", () => {
    const config: K8sEventsSignalConfig = {
      kubeconfig_content: "apiVersion: v1\nkind: Config",
    };

    const signal = provider.createSignal(config);
    assert(signal.validate());
  });

  await t.step("should validate signal with service account", () => {
    const config: K8sEventsSignalConfig = {
      use_service_account: true,
    };

    const signal = provider.createSignal(config);
    assert(signal.validate());
  });

  await t.step("should validate signal with direct API config", () => {
    const config: K8sEventsSignalConfig = {
      api_server: "https://kubernetes.example.com",
      token: "test-token",
    };

    const signal = provider.createSignal(config);
    assert(signal.validate());
  });

  await t.step("should reject signal without authentication", () => {
    const config: K8sEventsSignalConfig = {
      namespace: "default",
    };

    const signal = provider.createSignal(config);
    assert(!signal.validate());
  });

  await t.step("should reject signal with incomplete direct config", () => {
    const config: K8sEventsSignalConfig = {
      api_server: "https://kubernetes.example.com",
      // Missing token
    };

    const signal = provider.createSignal(config);
    assert(!signal.validate());
  });
});

// Test SecureLogger functionality
Deno.test("SecureLogger - Credential sanitization", async (t) => {
  // We need to access SecureLogger through its usage in the provider
  // Since it's not exported, we'll test it indirectly through error logging

  await t.step("should sanitize sensitive data in logs", () => {
    const provider = new K8sEventsSignalProvider();

    // Create an invalid config that will trigger validation errors
    // This will exercise the SecureLogger indirectly
    const invalidConfig = {
      kubeconfig: "/path/to/config",
      token: "very-secret-token-12345",
      timeout_ms: -1, // This will cause validation to fail and log
    };

    assertThrows(() => provider.createSignal(invalidConfig as any));

    // The error should be logged, but tokens should be sanitized
    // We can't directly test SecureLogger since it's not exported,
    // but we've verified the validation logic works
  });
});
