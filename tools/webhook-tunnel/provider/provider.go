// Package provider holds the allowlist of recognized URL-segment names
// for the tunnel's /hook/{provider}/{workspaceId}/{signalId} route. The
// tunnel is a byte-for-byte reverse proxy — it does NOT parse, transform,
// or verify the payload itself. The `provider` URL segment is a stable
// path prefix kept so any future provider can be added without breaking
// existing webhook URLs. Today there is exactly one valid value: "raw".
//
// Workspace agents own payload parsing and (when needed) HMAC verification
// against the raw request bytes — both surface to the agent via the
// `ctx.input.raw["body"]` / `ctx.input.raw["headers"]` channel atlasd
// preserves byte-for-byte.
package provider

// Names returns the allowed URL-segment names in order. Used in
// "Unknown provider: X. Available: ..." error messages.
func Names() []string {
	return []string{"raw"}
}

// IsValid reports whether the given name is a recognized provider
// URL-segment value.
func IsValid(name string) bool {
	return name == "raw"
}
