package provider

import (
	"net/http"
	"strings"
	"testing"
)

func TestRawProvider(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("raw")
	if h == nil {
		t.Fatalf("raw provider not registered")
	}
	payload, desc, err := h.Transform(http.Header{}, []byte(`{"foo":"bar","n":42}`))
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload["foo"] != "bar" || payload["n"] != float64(42) {
		t.Errorf("payload mismatch: %v", payload)
	}
	if desc != "Raw webhook forwarded" {
		t.Errorf("desc: %q", desc)
	}
}

func TestRawProviderRejectsNonObject(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("raw")
	_, _, err := h.Transform(http.Header{}, []byte(`["not", "an", "object"]`))
	if err == nil {
		t.Errorf("expected error for non-object body")
	}
}

func TestRawProviderRejectsEmptyBody(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("raw")
	_, _, err := h.Transform(http.Header{}, nil)
	if err == nil {
		t.Errorf("expected error for empty body")
	}
}

func TestUnknownProvider(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	for _, name := range []string{"github", "bitbucket", "jira", ""} {
		if Get(name) != nil {
			t.Errorf("expected nil handler for %q (only `raw` is supported)", name)
		}
	}
}

func TestList(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	got := List()
	want := []string{"raw"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	if got[0] != want[0] {
		t.Errorf("want %q, got %q", want[0], got[0])
	}
	// Make sure the existing-providers prose stays in the suite somewhere
	// so a future grep for "raw provider" turns this file up.
	if !strings.Contains(strings.Join(got, ","), "raw") {
		t.Errorf("expected `raw` in provider list")
	}
}
