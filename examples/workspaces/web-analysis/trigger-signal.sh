#!/bin/bash

# Trigger web analysis signal with URL input

cd "$(dirname "$0")"

# Default URL if none provided
URL=${1:-"https://example.com"}
ANALYSIS_TYPE=${2:-"detailed"}

echo "🕷️  Triggering web analysis signal..."
echo "   URL: $URL"
echo "   Analysis Type: $ANALYSIS_TYPE"
echo ""

# Validate URL format
if [[ ! $URL =~ ^https?:// ]]; then
    echo "❌ Invalid URL format. Please provide a URL starting with http:// or https://"
    echo "   Usage: $0 \"https://example.com\" [analysis_type]"
    exit 1
fi

echo "📡 Sending analysis request via Atlas CLI..."

# Use Atlas CLI signal trigger (showcasing direct signal integration)
SIGNAL_DATA="{\"url\": \"$URL\", \"analysis_type\": \"$ANALYSIS_TYPE\"}"

echo "🔍 Signal data: $SIGNAL_DATA"
echo ""

# Trigger signal using Atlas CLI
deno run \
  --allow-all \
  --unstable-broadcast-channel \
  --unstable-worker-options \
  --env-file \
  ../../../src/cli.tsx signal trigger webpage-analysis --data "$SIGNAL_DATA"

RESULT=$?

if [ $RESULT -eq 0 ]; then
    echo ""
    echo "✅ Analysis signal sent successfully!"
    echo ""
    echo "🔍 Alternative trigger methods:"
    echo ""
    echo "1. CLI with different analysis type:"
    echo "   $0 \"$URL\" \"accessibility\""
    echo ""
    echo "2. Different URLs to test:"
    echo "   $0 \"https://news.ycombinator.com\""
    echo "   $0 \"https://github.com/anthropics/claude-code\""
    echo "   $0 \"https://docs.anthropic.com\""
else
    echo ""
    echo "❌ Failed to send analysis signal"
    echo "   Exit code: $RESULT"
    echo "   Check if the Atlas server is running with: ./start-server.sh"
fi