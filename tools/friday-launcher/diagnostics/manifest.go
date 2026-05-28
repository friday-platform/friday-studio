package diagnostics

import (
	"bytes"
	"time"

	"gopkg.in/yaml.v3"
)

// Stable skip-reason tokens (design v3 § "Skip reasons (stable enum)").
// Runtime and goldens emit through these consts so a typo breaks the
// build, not the support tooling that downstream consumes manifests.
const (
	skipReasonUserOptedOut        = "user_opted_out"
	skipReasonDaemonUnreachable   = "daemon_unreachable"
	skipReasonDaemonReturned5xx   = "daemon_returned_5xx"
	skipReasonAuthRefused         = "auth_refused"
	skipReasonBundleAllTimeout    = "bundle_all_timeout"
	skipReasonBundleAllTooLarge   = "bundle_all_too_large"
	skipReasonDownloadsUnwritable = "downloads_unwritable"
)

// daemonVersionUnreachable is the reserved literal that means "could
// not get a version out of the daemon" (design v3 § "Further Notes").
// Any other value is opaque to support tooling.
const daemonVersionUnreachable = "unreachable"

// privacyHeader prepends every manifest. It's the user-facing safety
// brake on log redaction — explicit "logs are NOT redacted, review
// before sharing." Emit literally rather than via yaml head-comments
// (yaml.v3 doesn't emit head comments on document nodes reliably).
const privacyHeader = `# Friday diagnostic export
#
# Workspace bundles (if present) have credentials stripped.
# Log files are NOT redacted — review the contents of logs/
# before sharing this archive publicly.

`

type manifest struct {
	DaemonVersion              string           `yaml:"daemon_version"`
	OS                         string           `yaml:"os"`
	Arch                       string           `yaml:"arch"`
	GeneratedAt                time.Time        `yaml:"generated_at"`
	IncludeWorkspacesRequested bool             `yaml:"include_workspaces_requested"`
	Included                   manifestIncluded `yaml:"included"`
	Skipped                    []manifestSkip   `yaml:"skipped"`
}

type manifestIncluded struct {
	Logs       []string `yaml:"logs"`
	StateJSON  bool     `yaml:"state_json"`
	Pids       bool     `yaml:"pids"`
	Workspaces bool     `yaml:"workspaces"`
}

type manifestSkip struct {
	What string `yaml:"what"`
	Why  string `yaml:"why"`
}

// marshalManifest prepends the privacy header to a yaml-encoded body.
func marshalManifest(m manifest) ([]byte, error) {
	body, err := yaml.Marshal(m)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	buf.WriteString(privacyHeader)
	buf.Write(body)
	return buf.Bytes(), nil
}
