package passphrase

import (
	"strings"
	"testing"
)

func TestGenerateShape(t *testing.T) {
	got := Generate()
	parts := strings.Split(got, "-")
	if len(parts) != 4 {
		t.Fatalf("expected 4 hyphenated words, got %d in %q", len(parts), got)
	}
	for _, p := range parts {
		if p == "" {
			t.Fatalf("empty word in passphrase: %q", got)
		}
		if strings.ToLower(p) != p {
			t.Fatalf("non-lowercase word %q in %q", p, got)
		}
	}
}

func TestGenerateUniqueness(t *testing.T) {
	// Statistical: 100 generations should produce at least 95 unique
	// outputs given >4M passphrase combinations.
	seen := map[string]struct{}{}
	for range 100 {
		seen[Generate()] = struct{}{}
	}
	if len(seen) < 95 {
		t.Fatalf("expected ≥95 unique passphrases in 100, got %d", len(seen))
	}
}
