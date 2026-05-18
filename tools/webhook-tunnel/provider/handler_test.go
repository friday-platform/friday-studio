package provider

import (
	"strings"
	"testing"
)

func TestIsValidAcceptsRaw(t *testing.T) {
	if !IsValid("raw") {
		t.Errorf("expected `raw` to be a valid provider name")
	}
}

func TestIsValidRejectsRemovedProviders(t *testing.T) {
	for _, name := range []string{"github", "bitbucket", "jira", ""} {
		if IsValid(name) {
			t.Errorf("expected %q to be rejected (only `raw` is supported)", name)
		}
	}
}

func TestNames(t *testing.T) {
	got := Names()
	if len(got) != 1 {
		t.Fatalf("want exactly 1 provider name, got %v", got)
	}
	if got[0] != "raw" {
		t.Errorf("want `raw`, got %q", got[0])
	}
	// Keep "raw provider" prose in the suite so a future grep turns
	// this file up.
	if !strings.Contains(strings.Join(got, ","), "raw") {
		t.Errorf("expected `raw` in provider list")
	}
}
