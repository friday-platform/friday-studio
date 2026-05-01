// Package tunnel manages the cloudflared subprocess. The Manager is
// the only public surface — callers ask "is the tunnel alive and
// what's its URL" via Status() and never need to know cloudflared
// exists. This package owns the only place in the codebase that
// pattern-matches cloudflared log lines, so a future cloudflared
// release that changes its log format touches one file.
package tunnel

import (
	"regexp"
	"time"
)

// EventKind describes a cloudflared lifecycle event surfaced by the
// log parser to the supervisor goroutine.
type EventKind int

const (
	// EventURL signals that cloudflared printed the public tunnel URL
	// (quick tunnels via try.cloudflare.com). Includes the URL.
	EventURL EventKind = iota
	// EventConnected signals one edge connection went live. Multiple
	// EventConnected/EventDisconnected pairs interleave during normal
	// operation as edge connections balance.
	EventConnected
	// EventDisconnected signals one edge connection dropped.
	EventDisconnected
	// EventExit signals the cloudflared process exited.
	EventExit
)

// Event flows from the log parser to the supervisor.
type Event struct {
	Kind EventKind
	URL  string // only set for EventURL
	When time.Time
}

// Log-line parsing rules. These are the upstream-fragile bits, pinned
// in one place so a future cloudflared release that changes the
// format only touches this file.
//
// Patterns derived from observed cloudflared 2024.x output (the same
// ones the npm cloudflared package's ConfigHandler/TryCloudflareHandler
// match). We're intentionally lax — substring matching after compiling
// to a regex — because cloudflared's log shape varies between
// connection-protocol modes (QUIC vs HTTP2 etc.).
var (
	// Quick tunnel URL: appears in a banner like
	// "|  https://random-words.trycloudflare.com  |".
	quickURLPattern = regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)
	// Connection registered: "Registered tunnel connection ..."
	// Used by both quick AND named (token) tunnels.
	connectedPattern = regexp.MustCompile(`Registered tunnel connection|Connection .* registered`)
	// Connection lost: "Lost connection ..." or "Disconnected ...".
	disconnectedPattern = regexp.MustCompile(`Lost connection|Connection terminated|Disconnected`)
)

// parseLine inspects a single cloudflared log line and returns one
// or more events derived from it. Returns nil when the line carries
// no signal we care about (which is most lines).
func parseLine(line string, now time.Time) []Event {
	var events []Event
	if m := quickURLPattern.FindString(line); m != "" {
		events = append(events, Event{Kind: EventURL, URL: m, When: now})
	}
	// connected/disconnected can both appear in a single line in
	// cloudflared's reconnect chatter, so check both independently.
	if connectedPattern.MatchString(line) {
		events = append(events, Event{Kind: EventConnected, When: now})
	}
	if disconnectedPattern.MatchString(line) {
		events = append(events, Event{Kind: EventDisconnected, When: now})
	}
	return events
}
