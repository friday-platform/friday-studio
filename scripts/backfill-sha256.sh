#!/usr/bin/env bash
set -euo pipefail

# One-shot: write `.sha256` sidecars next to every studio + installer
# bundle already uploaded to GCS. Required after migrating publish
# workflows from "re-download and hash" to "read sidecar" — bundles
# uploaded before that migration don't have sidecars and would fail
# the publish-time verify step.
#
# Idempotent: skips bundles whose sidecar already exists.
#
# Usage:
#   GCS_BUCKET=my-bucket scripts/backfill-sha256.sh           # both prefixes
#   GCS_BUCKET=my-bucket scripts/backfill-sha256.sh studio    # only studio/
#   GCS_BUCKET=my-bucket scripts/backfill-sha256.sh installer # only installer/
#   GCS_BUCKET=my-bucket scripts/backfill-sha256.sh --dry-run # report only
#
# Requires: gsutil (gcloud SDK) authenticated against the project
# (e.g. `gcloud auth application-default login`).

DRY_RUN=false
PREFIXES=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    studio|installer) PREFIXES+=("$arg") ;;
    -h|--help)
      sed -n '3,17p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "${GCS_BUCKET:-}" ]]; then
  echo "Error: GCS_BUCKET env var must be set." >&2
  exit 1
fi
if ! command -v gsutil &>/dev/null; then
  echo "Error: gsutil required. Install via gcloud SDK." >&2
  exit 1
fi
[[ ${#PREFIXES[@]} -eq 0 ]] && PREFIXES=(studio installer)

# `gsutil ls -r gs://bucket/prefix/**` returns every object recursively.
# Filter to bundle extensions; skip already-existing sidecars and any
# non-archive files (manifest.json, etc).
is_bundle() {
  case "$1" in
    *.tar.zst|*.dmg|*-setup.exe) return 0 ;;
    *) return 1 ;;
  esac
}

backfill_one() {
  local obj="$1"
  local sidecar="$obj.sha256"
  local name
  name=$(basename "$obj")

  if gsutil -q stat "$sidecar" 2>/dev/null; then
    echo "  skip  $name (sidecar exists)"
    return 0
  fi

  if $DRY_RUN; then
    echo "  WOULD $name (no sidecar)"
    return 0
  fi

  echo "  hash  $name"
  local tmp sha
  tmp=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$tmp'" RETURN

  gsutil cp "$obj" "$tmp" >/dev/null
  sha=$(shasum -a 256 "$tmp" | awk '{print $1}')

  local sidecar_local="$tmp.sha256"
  printf '%s  %s\n' "$sha" "$name" > "$sidecar_local"
  gsutil cp "$sidecar_local" "$sidecar" >/dev/null
  rm -f "$sidecar_local"

  echo "  wrote $sidecar  ($sha)"
}

for prefix in "${PREFIXES[@]}"; do
  echo "==> gs://${GCS_BUCKET}/${prefix}/"
  # `gsutil ls -r` may return directory placeholders ending with /; skip
  # them. The 2>/dev/null swallows the "no matches" noise on empty paths.
  while IFS= read -r obj; do
    [[ -z "$obj" ]] && continue
    [[ "$obj" == */ ]] && continue
    [[ "$obj" == *.sha256 ]] && continue
    if ! is_bundle "$obj"; then
      continue
    fi
    backfill_one "$obj"
  done < <(gsutil ls -r "gs://${GCS_BUCKET}/${prefix}/**" 2>/dev/null || true)
done

echo "Done."
