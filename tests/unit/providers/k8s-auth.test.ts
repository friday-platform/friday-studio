/**
 * Unit tests for Kubernetes Authentication Manager
 * Tests security functions and HTTP header creation (no cluster required)
 */

import { assertEquals } from "jsr:@std/assert";
import { K8sAuthConfig, K8sAuthManager } from "../../../src/core/providers/builtin/k8s-auth.ts";

Deno.test("K8sAuthManager - HTTP headers", async (t) => {
  await t.step("should create proper auth headers with token", () => {
    const authConfig: K8sAuthConfig = {
      server: "https://kubernetes.example.com",
      token: "test-token",
    };

    const headers = K8sAuthManager.createAuthHeaders(authConfig);

    assertEquals(headers["Authorization"], "Bearer test-token");
    assertEquals(headers["Accept"], "application/json");
    assertEquals(headers["User-Agent"], "atlas-k8s-watch/1.0.0");
  });

  await t.step("should create headers without token", () => {
    const authConfig: K8sAuthConfig = {
      server: "https://kubernetes.example.com",
    };

    const headers = K8sAuthManager.createAuthHeaders(authConfig);

    assertEquals(headers["Authorization"], undefined);
    assertEquals(headers["Accept"], "application/json");
    assertEquals(headers["User-Agent"], "atlas-k8s-watch/1.0.0");
  });

  await t.step("should not create auth header with empty token", () => {
    const authConfig: K8sAuthConfig = {
      server: "https://kubernetes.example.com",
      token: "",
    };

    const headers = K8sAuthManager.createAuthHeaders(authConfig);

    assertEquals(headers["Authorization"], undefined);
    assertEquals(headers["Accept"], "application/json");
    assertEquals(headers["User-Agent"], "atlas-k8s-watch/1.0.0");
  });
});
