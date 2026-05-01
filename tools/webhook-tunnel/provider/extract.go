package provider

import (
	"strconv"
	"strings"
)

// extractByPath walks a parsed JSON value (map[string]any /
// []any nested) along a dot-path with optional array-index segments.
//
// Examples:
//
//	"pull_request.html_url"   → obj["pull_request"]["html_url"]
//	"push.changes[0].new.name" → obj["push"]["changes"][0]["new"]["name"]
//
// Returns nil for any missing key, out-of-bounds index, or wrong type
// along the path. Mirrors the TS implementation in
// apps/webhook-tunnel/src/providers.ts:extractByPath.
func extractByPath(root any, path string) any {
	current := root
	for _, segment := range strings.Split(path, ".") {
		if current == nil {
			return nil
		}
		key, idx, hasIdx := splitArraySegment(segment)
		m, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = m[key]
		if !hasIdx {
			continue
		}
		arr, ok := current.([]any)
		if !ok || idx < 0 || idx >= len(arr) {
			return nil
		}
		current = arr[idx]
	}
	return current
}

// splitArraySegment parses "name[0]" into ("name", 0, true). Plain
// "name" returns ("name", 0, false). Malformed forms (e.g. "name[abc]"
// or "name[]") return as plain key (hasIdx=false) so the segment is
// treated as a regular map key — same forgiving behavior as the TS
// regex `^([^[]+)\[(\d+)]$` which silently ignores non-matching forms.
func splitArraySegment(segment string) (key string, idx int, hasIdx bool) {
	open := strings.IndexByte(segment, '[')
	if open == -1 || !strings.HasSuffix(segment, "]") {
		return segment, 0, false
	}
	key = segment[:open]
	if key == "" {
		return segment, 0, false
	}
	inner := segment[open+1 : len(segment)-1]
	n, err := strconv.Atoi(inner)
	if err != nil {
		return segment, 0, false
	}
	return key, n, true
}
