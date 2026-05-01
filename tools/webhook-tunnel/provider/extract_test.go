package provider

import (
	"encoding/json"
	"reflect"
	"testing"
)

func mustJSON(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	return v
}

func TestExtractByPath(t *testing.T) {
	body := mustJSON(t, `{
		"pull_request": {
			"html_url": "https://github.com/x/y/pull/1",
			"number": 42,
			"head": { "sha": "abc123" }
		},
		"push": {
			"changes": [
				{ "new": { "name": "main", "target": { "hash": "deadbeef" } } },
				{ "new": { "name": "feature" } }
			]
		},
		"repository": { "full_name": "x/y" }
	}`)

	cases := []struct {
		path string
		want any
	}{
		// flat key
		{"repository.full_name", "x/y"},
		// 2-level nested
		{"pull_request.html_url", "https://github.com/x/y/pull/1"},
		{"pull_request.number", float64(42)}, // JSON numbers are float64
		// 3-level nested
		{"pull_request.head.sha", "abc123"},
		// array indexing
		{"push.changes[0].new.name", "main"},
		{"push.changes[1].new.name", "feature"},
		{"push.changes[0].new.target.hash", "deadbeef"},
		// missing key → nil
		{"pull_request.nonexistent", nil},
		{"nonexistent.foo", nil},
		// out of bounds → nil
		{"push.changes[99].new.name", nil},
		// wrong type at midway → nil
		{"pull_request.html_url.boom", nil},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			got := extractByPath(body, c.path)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("extractByPath(%q) = %v, want %v", c.path, got, c.want)
			}
		})
	}
}

func TestSplitArraySegment(t *testing.T) {
	cases := []struct {
		in      string
		key     string
		idx     int
		hasIdx  bool
		comment string
	}{
		{"name", "name", 0, false, "plain key"},
		{"name[0]", "name", 0, true, "first index"},
		{"name[42]", "name", 42, true, "larger index"},
		// malformed forms fall back to plain key
		{"name[abc]", "name[abc]", 0, false, "non-numeric"},
		{"name[]", "name[]", 0, false, "empty index"},
		{"[0]", "[0]", 0, false, "no key"},
	}
	for _, c := range cases {
		t.Run(c.comment, func(t *testing.T) {
			k, i, h := splitArraySegment(c.in)
			if k != c.key || i != c.idx || h != c.hasIdx {
				t.Errorf("split(%q) = (%q, %d, %v), want (%q, %d, %v)",
					c.in, k, i, h, c.key, c.idx, c.hasIdx)
			}
		})
	}
}
