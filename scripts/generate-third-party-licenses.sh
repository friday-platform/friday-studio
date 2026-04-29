#!/usr/bin/env bash
# Generate THIRD_PARTY_LICENSES.md by inventorying every third-party dependency
# bundled into a shipped Friday Studio artifact.
#
# Sources:
#   - Go modules        -> go list -m all + module cache LICENSE file
#   - Rust crates       -> cargo license --json (apps/studio-installer/src-tauri)
#   - npm / JSR packages -> deno.lock + package.json metadata
#
# Required tools: go, cargo, cargo-license, jq, deno
#
# Run from the repository root. Output is written to THIRD_PARTY_LICENSES.md.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

OUT="$ROOT/THIRD_PARTY_LICENSES.md"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required tool not found: $1" >&2
    exit 1
  fi
}
require go
require cargo
require cargo-license
require jq

GOPATH="${GOPATH:-$(go env GOPATH)}"
MODCACHE="$GOPATH/pkg/mod"

detect_license_file() {
  local dir="$1"
  for name in LICENSE LICENSE.md LICENSE.txt LICENCE LICENCE.md COPYING COPYING.md NOTICE NOTICE.md; do
    if [[ -f "$dir/$name" ]]; then
      echo "$dir/$name"
      return 0
    fi
  done
  return 1
}

detect_license_name() {
  local file="$1"
  local head
  head="$(head -c 4096 "$file" 2>/dev/null || true)"
  case "$head" in
    *"Apache License"*"Version 2.0"*) echo "Apache-2.0" ;;
    *"MIT License"*|*"Permission is hereby granted, free of charge"*) echo "MIT" ;;
    *"BSD 3-Clause"*|*"Redistribution and use in source and binary forms"*"Neither the name"*) echo "BSD-3-Clause" ;;
    *"BSD 2-Clause"*|*"Redistribution and use in source and binary forms"*) echo "BSD-2-Clause" ;;
    *"Mozilla Public License"*"2.0"*) echo "MPL-2.0" ;;
    *"GNU GENERAL PUBLIC LICENSE"*"Version 3"*) echo "GPL-3.0" ;;
    *"GNU LESSER GENERAL PUBLIC LICENSE"*) echo "LGPL" ;;
    *"ISC License"*|*"Permission to use, copy, modify, and/or distribute this software"*) echo "ISC" ;;
    *"The Unlicense"*) echo "Unlicense" ;;
    *"CC0 1.0 Universal"*) echo "CC0-1.0" ;;
    *) echo "see file" ;;
  esac
}

emit_header() {
  cat <<'EOF' > "$OUT"
# Third-Party Licenses

This file lists every third-party dependency bundled into a shipped Friday
Studio artifact (the daemon, CLI, web playground, Friday Launcher,
webhook tunnel, and Studio Installer). It is generated automatically by
[`scripts/generate-third-party-licenses.sh`](scripts/generate-third-party-licenses.sh).

For dual-licensed packages we accept the first license listed in the package
metadata. Where we have made an explicit license election (e.g. jszip), the
election is recorded in [`NOTICE`](NOTICE).

Run `bash scripts/generate-third-party-licenses.sh` to regenerate after a
dependency bump.

EOF
}

emit_go() {
  echo "## Go modules" >> "$OUT"
  echo >> "$OUT"
  echo "Bundled into: \`tools/friday-launcher\`, \`tools/webhook-tunnel\`." >> "$OUT"
  echo >> "$OUT"
  echo "| Module | Version | License | Source |" >> "$OUT"
  echo "| --- | --- | --- | --- |" >> "$OUT"

  go list -m -json all 2>/dev/null \
    | jq -r 'select(.Main != true and (.Path | startswith("github.com/friday-platform/friday-studio") | not)) | "\(.Path)|\(.Version)|\(.Dir // "")"' \
    | sort -u \
    | while IFS='|' read -r path version dir; do
        [[ -z "$path" ]] && continue
        license="see source"
        if [[ -n "$dir" && -d "$dir" ]]; then
          if license_file="$(detect_license_file "$dir")"; then
            license="$(detect_license_name "$license_file")"
          fi
        fi
        echo "| \`$path\` | $version | $license | https://pkg.go.dev/$path |" >> "$OUT"
      done

  echo >> "$OUT"
}

emit_rust() {
  echo "## Rust crates" >> "$OUT"
  echo >> "$OUT"
  echo "Bundled into: \`apps/studio-installer\` (Tauri installer binary)." >> "$OUT"
  echo >> "$OUT"
  echo "| Crate | Version | License | Source |" >> "$OUT"
  echo "| --- | --- | --- | --- |" >> "$OUT"

  ( cd apps/studio-installer/src-tauri && cargo license --json 2>/dev/null ) \
    | jq -r '.[] | select(.name != "studio-installer") | "| `\(.name)` | \(.version) | \(.license // "see source") | \(.repository // "n/a") |"' \
    | sort -u >> "$OUT"

  echo >> "$OUT"
}

emit_node() {
  echo "## npm / JSR packages" >> "$OUT"
  echo >> "$OUT"
  echo "Bundled into: the Atlas daemon, CLI, web playground, and any compiled" >> "$OUT"
  echo "Deno binaries. Inventory is taken from \`deno.lock\`." >> "$OUT"
  echo >> "$OUT"
  echo "| Package | Version | Source |" >> "$OUT"
  echo "| --- | --- | --- |" >> "$OUT"

  # deno.lock keys look like:
  #   "@scope/name@1.2.3_peerdep@4.5.6"  (scoped, with peer-dep marker)
  #   "name@1.2.3"                       (unscoped)
  # Extract the package name and the leading semver before any "_" peer-dep suffix.
  parse_key='
    capture("^(?<pkg>@[^/]+/[^@]+|[^@]+)@(?<ver>[^_]+)") // null
    | select(. != null)
  '

  if [[ -f deno.lock ]]; then
    jq -r --arg parse "$parse_key" '
      [
        (.npm // {}) | keys[] | (. | capture("^(?<pkg>@[^/]+/[^@]+|[^@]+)@(?<ver>[^_]+)") // null)
        | select(. != null)
        | "| `\(.pkg)` | \(.ver) | https://www.npmjs.com/package/\(.pkg) |"
      ] | sort | unique | .[]
    ' deno.lock 2>/dev/null >> "$OUT" || true

    jq -r '
      [
        (.jsr // {}) | keys[] | (. | capture("^(?<pkg>@[^/]+/[^@]+|[^@]+)@(?<ver>[^_]+)") // null)
        | select(. != null)
        | "| `\(.pkg)` | \(.ver) | https://jsr.io/\(.pkg) |"
      ] | sort | unique | .[]
    ' deno.lock 2>/dev/null >> "$OUT" || true
  fi

  echo >> "$OUT"
}

emit_footer() {
  cat <<EOF >> "$OUT"
## How to retrieve full license text

The table above lists each dependency's SPDX license identifier and source URL.
The full license text for any individual package can be fetched from:

- **Go modules**: \`\$(go env GOPATH)/pkg/mod/<module>@<version>/LICENSE\`
- **Rust crates**: \`~/.cargo/registry/src/index.crates.io-*/<crate>-<version>/LICENSE*\`
- **npm packages**: \`<package_url>\` or the package's GitHub repository
- **JSR packages**: the \`license\` field on the package's jsr.io page

Release artifacts (Tauri installer, compiled Go binaries) bundle their full
license texts under their respective resources directories per the Apache-2.0,
MIT, and BSD attribution requirements.

Generated: $(date -u +"%Y-%m-%d")
EOF
}

emit_header
emit_go
emit_rust
emit_node
emit_footer

echo "wrote $OUT"
