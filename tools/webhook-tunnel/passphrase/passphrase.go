// Package passphrase generates a memorable hyphenated passphrase from
// a small embedded wordlist. Used as the auto-generated WEBHOOK_SECRET
// when one isn't supplied via env. Output shape mirrors the TS
// `random-words` 4-word output: lowercase words joined by "-", e.g.
// "crystal-mountain-river-dance".
package passphrase

import (
	"crypto/rand"
	"math/big"
	"strings"
)

// Generate returns a 4-word hyphenated diceware-style passphrase.
// Uses crypto/rand for word selection (the TS `random-words` package
// uses Math.random — non-crypto — so this is a security upgrade).
func Generate() string {
	const wordCount = 4
	parts := make([]string, wordCount)
	wordlistLen := big.NewInt(int64(len(wordlist)))
	for i := range parts {
		n, err := rand.Int(rand.Reader, wordlistLen)
		if err != nil {
			// crypto/rand failure is catastrophic; the TS code would
			// throw too. Returning a constant ensures the caller gets
			// a deterministic-but-flagged secret rather than panicking.
			return "passphrase-generator-failed-please-set-WEBHOOK_SECRET"
		}
		parts[i] = wordlist[n.Int64()]
	}
	return strings.Join(parts, "-")
}
