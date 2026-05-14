package main

import (
	"slices"
	"testing"
)

// TestCommonServiceEnv_OAuthShimDisabledWithoutBrowserCert pins the
// safety condition. Without a valid browser cert the playground stays
// on plain http://localhost and the Cloud Function would accept the
// callback URL as-is; injecting shim env vars would still work but
// they'd be redundant. We keep them off so the env is minimal and so
// dev rigs (no cert) behave exactly like they did pre-shim.
func TestCommonServiceEnv_OAuthShimDisabledWithoutBrowserCert(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	// No browser cert planted — hasValidBrowserCert returns false.

	env := commonServiceEnv()
	for _, kv := range env {
		for _, forbidden := range []string{"PLAYGROUND_OAUTH_SHIM_PORT=", "FRIDAY_OAUTH_SHIM_BASE="} {
			if len(kv) >= len(forbidden) && kv[:len(forbidden)] == forbidden {
				t.Errorf("shim env leaked into commonServiceEnv without a valid browser cert: %q", kv)
			}
		}
	}
}

// TestCommonServiceEnv_OAuthShimEmittedWithBrowserCert is the
// canonical desktop-install case. With a valid browser cert in place
// the launcher must add both PLAYGROUND_OAUTH_SHIM_PORT (so the
// playground binds the listener) and FRIDAY_OAUTH_SHIM_BASE (so Link's
// delegated flow rewrites the OAuth state.uri host).
func TestCommonServiceEnv_OAuthShimEmittedWithBrowserCert(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	writeValidBrowserCert(t, tmp)

	env := commonServiceEnv()
	if !slices.Contains(env, "PLAYGROUND_OAUTH_SHIM_PORT=5201") {
		t.Errorf("env missing PLAYGROUND_OAUTH_SHIM_PORT=5201\nfull env: %v", env)
	}
	if !slices.Contains(env, "FRIDAY_OAUTH_SHIM_BASE=http://127.0.0.1:5201") {
		t.Errorf("env missing FRIDAY_OAUTH_SHIM_BASE=http://127.0.0.1:5201\nfull env: %v", env)
	}
}

// TestPlaygroundShimPort_UsesPlaygroundPortPlusOne pins the +1
// derivation. The launcher's port-override mechanism already moves
// playground 5200 → 15200; the shim should follow without an extra
// knob.
func TestPlaygroundShimPort_UsesPlaygroundPortPlusOne(t *testing.T) {
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")
	if got := playgroundShimPort(); got != 15201 {
		t.Errorf("playgroundShimPort with override 15200 = %d, want 15201", got)
	}
}

// TestPlaygroundShimPort_ExplicitOverrideWins lets operators escape a
// port collision via PLAYGROUND_OAUTH_SHIM_PORT in .env.
func TestPlaygroundShimPort_ExplicitOverrideWins(t *testing.T) {
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")
	t.Setenv("PLAYGROUND_OAUTH_SHIM_PORT", "20000")
	if got := playgroundShimPort(); got != 20000 {
		t.Errorf("playgroundShimPort with explicit override = %d, want 20000", got)
	}
}

// TestPlaygroundShimPort_DefaultsTo5201 covers the no-override path —
// matches playground's pre-override default of 5200 + 1.
func TestPlaygroundShimPort_DefaultsTo5201(t *testing.T) {
	if got := playgroundShimPort(); got != 5201 {
		t.Errorf("playgroundShimPort default = %d, want 5201", got)
	}
}

// TestCommonServiceEnv_OAuthShimUsesPortOverride: when the operator
// pins FRIDAY_PORT_PLAYGROUND, the shim env must follow it so
// PLAYGROUND_OAUTH_SHIM_PORT = playground port + 1. Otherwise a
// non-default playground install with a default shim port collides
// with whatever's on 5201 in the operator's host.
func TestCommonServiceEnv_OAuthShimUsesPortOverride(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("FRIDAY_LAUNCHER_HOME", tmp)
	t.Setenv("HOME", tmp)
	t.Setenv("FRIDAY_PORT_PLAYGROUND", "15200")
	writeValidBrowserCert(t, tmp)

	env := commonServiceEnv()
	if !slices.Contains(env, "PLAYGROUND_OAUTH_SHIM_PORT=15201") {
		t.Errorf("env missing PLAYGROUND_OAUTH_SHIM_PORT=15201\nfull env: %v", env)
	}
	if !slices.Contains(env, "FRIDAY_OAUTH_SHIM_BASE=http://127.0.0.1:15201") {
		t.Errorf("env missing FRIDAY_OAUTH_SHIM_BASE=http://127.0.0.1:15201\nfull env: %v", env)
	}
}

// Cert helper writeValidBrowserCert is defined in probe_scheme_test.go;
// reuse it here to keep test infrastructure DRY.
