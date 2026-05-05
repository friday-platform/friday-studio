#!/usr/bin/env bash
set -euo pipefail

# Wrapper around the studio-build / studio-publish (and installer pair)
# workflows so releases don't require remembering gh syntax. Build only
# uploads versioned artifacts to GCS; publish flips the manifest pointer
# clients resolve. The two are deliberately separate (test before promote).
#
# Usage:
#   scripts/studio-release.sh build {studio|installer} [--ref BRANCH] [--watch]
#       Triggers the build workflow. With --watch, blocks until done and
#       prints the exact publish command to run next.
#
#   scripts/studio-release.sh publish {studio|installer} [RUN_ID]
#       Promotes a build to clients. With no RUN_ID, picks the most recent
#       successful build of that kind. Auto-derives the version by peeking
#       at one tiny manifest-entry artifact, then asks for confirmation.
#
# Examples:
#   scripts/studio-release.sh build studio --watch
#   scripts/studio-release.sh publish studio
#   scripts/studio-release.sh publish installer 12345678901

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI required. Install: https://cli.github.com" >&2
  exit 1
fi
if ! gh auth status &>/dev/null; then
  echo "Error: not logged in. Run: gh auth login" >&2
  exit 1
fi
if ! command -v python3 &>/dev/null; then
  echo "Error: python3 required (used to parse manifest-entry JSON)." >&2
  exit 1
fi

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
if [[ -z "$REPO" ]]; then
  echo "Error: could not determine GitHub repo. Run from inside the repo." >&2
  exit 1
fi

usage() {
  cat <<EOF
Usage:
  $(basename "$0") build {studio|installer} [--ref BRANCH] [--watch]
  $(basename "$0") publish {studio|installer} [RUN_ID]

Build only uploads versioned artifacts. Publish promotes a build by
rewriting manifest.json. Use 'publish' with no RUN_ID to ship the
latest successful build of that kind.
EOF
}

build_workflow_for() {
  case "$1" in
    studio)    echo "studio-build.yml" ;;
    installer) echo "studio-installer-build.yml" ;;
    *) echo "unknown kind: $1 (expected: studio | installer)" >&2; exit 2 ;;
  esac
}

publish_workflow_for() {
  case "$1" in
    studio)    echo "studio-publish.yml" ;;
    installer) echo "studio-installer-publish.yml" ;;
    *) echo "unknown kind: $1 (expected: studio | installer)" >&2; exit 2 ;;
  esac
}

# gh workflow run returns no run id, so poll the run list (filtered by
# workflow file) right after dispatch. New runs appear within a couple
# seconds; retry up to ~20s before giving up.
find_new_run_id() {
  local wf="$1" since="$2"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    local id
    id=$(gh run list --workflow="$wf" --limit=1 \
      --json databaseId,createdAt \
      --jq ".[] | select(.createdAt >= \"$since\") | .databaseId" 2>/dev/null || true)
    if [[ -n "$id" ]]; then echo "$id"; return 0; fi
  done
  return 1
}

cmd_build() {
  local kind="${1:-}"; [[ -z "$kind" ]] && { usage; exit 2; }
  shift

  local ref="" watch=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ref) ref="${2:-}"; shift 2 ;;
      --watch) watch=true; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
  done

  local wf
  wf=$(build_workflow_for "$kind")

  # Capture an ISO timestamp just before dispatch so we can disambiguate
  # our run from any concurrent ones that may already be queued.
  local since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  echo "→ Triggering $wf${ref:+ on $ref}…"
  if [[ -n "$ref" ]]; then
    gh workflow run "$wf" --ref "$ref"
  else
    gh workflow run "$wf"
  fi

  echo "→ Locating new run…"
  local run_id
  if ! run_id=$(find_new_run_id "$wf" "$since"); then
    echo "Could not find new run within timeout. Check the Actions tab." >&2
    exit 1
  fi

  echo "  Run id : $run_id"
  echo "  URL    : https://github.com/$REPO/actions/runs/$run_id"

  if $watch; then
    echo "→ Watching… (Ctrl-C is safe; the run continues on GitHub)"
    if gh run watch "$run_id" --exit-status; then
      echo
      echo "✓ Build complete. To promote it to clients:"
      echo "    $(basename "$0") publish $kind $run_id"
    else
      echo
      echo "✗ Build failed. See: https://github.com/$REPO/actions/runs/$run_id" >&2
      exit 1
    fi
  fi
}

# Download one manifest-entry artifact from a build run and parse the
# version out of its url field. Cheap (<1KB per artifact) and avoids
# needing to encode version into the artifact name. Returns empty
# string on any failure so the caller can surface a clean error.
version_from_run() {
  local run_id="$1" kind="$2"
  local pattern
  case "$kind" in
    studio)    pattern="studio-manifest-entry-*" ;;
    installer) pattern="manifest-entry-*" ;;
  esac

  local tmp
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064  # intentional eager expansion of $tmp
  trap "rm -rf '$tmp'" RETURN

  if ! gh run download "$run_id" --pattern "$pattern" --dir "$tmp" >/dev/null 2>&1; then
    echo ""; return
  fi

  local first
  first=$(find "$tmp" -name '*.json' -print -quit)
  if [[ -z "$first" ]]; then echo ""; return; fi

  python3 - "$first" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1]))
# studio entry: { "<platform>": {"url": ...} }
# installer entry: {"url": ...}
url = data["url"] if "url" in data else next(iter(data.values()))["url"]
m = re.search(r"_([0-9]+\.[0-9]+\.[0-9]+)_", url)
print(m.group(1) if m else "")
PY
}

cmd_publish() {
  local kind="${1:-}"; [[ -z "$kind" ]] && { usage; exit 2; }
  shift
  local run_id="${1:-}"

  local build_wf publish_wf
  build_wf=$(build_workflow_for "$kind")
  publish_wf=$(publish_workflow_for "$kind")

  if [[ -z "$run_id" ]]; then
    echo "→ Finding latest successful $build_wf run…"
    run_id=$(gh run list --workflow="$build_wf" --status=success --limit=1 \
      --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
    if [[ -z "$run_id" ]]; then
      echo "No successful runs found for $build_wf." >&2
      exit 1
    fi
  fi

  echo "→ Run $run_id:"
  gh run view "$run_id" --json displayTitle,headBranch,createdAt,status,conclusion \
    --template '  Title  : {{ .displayTitle }}
  Branch : {{ .headBranch }}
  When   : {{ .createdAt }}
  Result : {{ .status }} / {{ .conclusion }}
'

  echo "→ Deriving version from artifacts…"
  local version
  version=$(version_from_run "$run_id" "$kind")
  if [[ -z "$version" ]]; then
    echo "Could not derive version from run $run_id." >&2
    echo "(Artifacts may have expired — they're kept 30d — or the run id is wrong kind.)" >&2
    exit 1
  fi
  echo "  Version: $version"

  echo
  read -r -p "Publish $kind v$version from run $run_id? [y/N] " yn
  case "$yn" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 0 ;;
  esac

  echo "→ Triggering $publish_wf…"
  local since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run "$publish_wf" \
    -f "build_run_id=$run_id" \
    -f "version=$version"

  echo "→ Locating publish run…"
  local pub_id
  if pub_id=$(find_new_run_id "$publish_wf" "$since"); then
    echo "  URL: https://github.com/$REPO/actions/runs/$pub_id"
  else
    echo "  See: https://github.com/$REPO/actions/workflows/$publish_wf"
  fi
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    build)              cmd_build "$@" ;;
    publish)            cmd_publish "$@" ;;
    -h|--help|help|"")  usage ;;
    *) echo "unknown command: $cmd" >&2; usage; exit 2 ;;
  esac
}

main "$@"
