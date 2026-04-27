package provider

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
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
	if err := h.Verify(http.Header{}, []byte(`{}`), nil); err != nil {
		t.Errorf("raw should not require signature: %v", err)
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

func TestGitHubProviderHMAC(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("github")
	if h == nil {
		t.Fatalf("github provider not registered")
	}
	secret := []byte("hello")
	body := []byte(`{"action":"opened","pull_request":{"html_url":"https://github.com/x/y/pull/1"}}`)
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	headers := http.Header{}
	headers.Set("X-GitHub-Event", "pull_request")
	headers.Set("X-Hub-Signature-256", sig)

	if err := h.Verify(headers, body, secret); err != nil {
		t.Errorf("verify with correct sig should succeed: %v", err)
	}

	// Bad signature
	headers.Set("X-Hub-Signature-256", "sha256=deadbeef")
	if err := h.Verify(headers, body, secret); err == nil {
		t.Errorf("verify with bad sig should fail")
	}

	// Missing header
	headers.Del("X-Hub-Signature-256")
	if err := h.Verify(headers, body, secret); err == nil {
		t.Errorf("verify with missing header should fail")
	}

	// No secret configured = always passes
	headers.Set("X-Hub-Signature-256", "anything")
	if err := h.Verify(headers, body, nil); err != nil {
		t.Errorf("verify without secret should succeed: %v", err)
	}
}

func TestGitHubProviderTransform(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("github")

	// Pull request: opened action → mapped, payload extracted.
	body := []byte(`{
		"action": "opened",
		"pull_request": { "html_url": "https://github.com/x/y/pull/1" }
	}`)
	headers := http.Header{}
	headers.Set("X-GitHub-Event", "pull_request")

	payload, desc, err := h.Transform(headers, body)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload["pr_url"] != "https://github.com/x/y/pull/1" {
		t.Errorf("payload: %v", payload)
	}
	if !strings.Contains(desc, "github pull_request opened") {
		t.Errorf("desc: %q", desc)
	}

	// Pull request: closed action → silently skipped (not in actions list).
	bodyClosed := []byte(`{"action":"closed","pull_request":{"html_url":"x"}}`)
	payload, _, err = h.Transform(headers, bodyClosed)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload != nil {
		t.Errorf("expected nil payload for filtered action, got %v", payload)
	}

	// Unknown event header → silently skipped.
	headers.Set("X-GitHub-Event", "deployment")
	payload, _, err = h.Transform(headers, body)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload != nil {
		t.Errorf("expected nil payload for unknown event, got %v", payload)
	}
}

func TestBitbucketArrayPath(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("bitbucket")
	if h == nil {
		t.Fatalf("bitbucket not registered")
	}
	body := []byte(`{
		"repository": { "full_name": "x/y" },
		"push": { "changes": [
			{ "new": { "name": "main", "target": { "hash": "deadbeef" } } }
		]}
	}`)
	headers := http.Header{}
	headers.Set("X-Event-Key", "repo:push")
	payload, _, err := h.Transform(headers, body)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload["branch"] != "main" {
		t.Errorf("branch: want main, got %v", payload["branch"])
	}
	if payload["sha"] != "deadbeef" {
		t.Errorf("sha: want deadbeef, got %v", payload["sha"])
	}
}

func TestJiraEventField(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("jira")
	if h == nil {
		t.Fatalf("jira not registered")
	}
	body := []byte(`{
		"webhookEvent": "jira:issue_created",
		"issue": {
			"key": "PROJ-1",
			"fields": { "project": { "key": "PROJ" }, "summary": "thing" }
		}
	}`)
	payload, _, err := h.Transform(http.Header{}, body)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload["issue_key"] != "PROJ-1" {
		t.Errorf("issue_key: %v", payload)
	}
	if payload["project_key"] != "PROJ" {
		t.Errorf("project_key: %v", payload)
	}
	if payload["summary"] != "thing" {
		t.Errorf("summary: %v", payload)
	}
}

func TestList(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	got := List()
	want := []string{"bitbucket", "github", "jira", "raw"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("List[%d]: want %q, got %q", i, w, got[i])
		}
	}
}
