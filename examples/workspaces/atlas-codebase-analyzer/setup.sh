#!/bin/bash

# Atlas Codebase Analyzer Setup Script
# Sets up and runs the autonomous codebase analysis workspace

set -e

echo "🚀 Atlas Codebase Analyzer Setup"
echo "=================================="

# Check if we're in the right directory
if [[ ! -f "workspace.yml" ]]; then
    echo "❌ Error: workspace.yml not found. Please run from the atlas-codebase-analyzer directory."
    exit 1
fi

# Check for Anthropic API key
if [[ -z "$ANTHROPIC_API_KEY" && ! -f ".env" ]]; then
    echo "⚠️  ANTHROPIC_API_KEY not found."
    echo "Please set your API key:"
    echo "  export ANTHROPIC_API_KEY=your-key-here"
    echo "  OR"
    echo "  echo 'ANTHROPIC_API_KEY=your-key-here' > .env"
    exit 1
fi

echo "✅ Environment check passed"

# Navigate to Atlas root
cd ../../..
ATLAS_ROOT=$(pwd)
WORKSPACE_PATH="examples/workspaces/atlas-codebase-analyzer"

echo "📍 Atlas root: $ATLAS_ROOT"
echo "📍 Workspace path: $WORKSPACE_PATH"

# Validate workspace configuration
echo "🔍 Validating workspace configuration..."
if deno task atlas workspace validate --workspace "$WORKSPACE_PATH"; then
    echo "✅ Workspace configuration is valid"
else
    echo "❌ Workspace configuration validation failed"
    echo "💡 Try: deno task atlas workspace validate --workspace $WORKSPACE_PATH --verbose"
    exit 1
fi

# Check for required agents and signals
echo "🤖 Checking agent and signal definitions..."
echo "Configured agents:"
echo "  - performance-analyzer (LLM agent for performance analysis)"
echo "  - dx-analyzer (LLM agent for developer experience)"  
echo "  - architecture-analyzer (LLM agent for architecture review)"
echo "  - report-generator (LLM agent for report synthesis)"
echo ""
echo "Configured signals:"
echo "  - codebase-watcher (File monitoring - NOT YET IMPLEMENTED)"
echo "  - manual-analysis (HTTP webhook for manual triggers)"
echo "  - weekly-review (Scheduled analysis - NOT YET IMPLEMENTED)"
echo ""

# Start workspace server in background
echo "🖥️  Starting workspace server..."
echo "Command: deno task atlas workspace serve --workspace $WORKSPACE_PATH"
echo ""
echo "📊 To monitor the workspace, run in another terminal:"
echo "   deno task atlas tui --workspace $WORKSPACE_PATH"
echo ""
echo "🧪 To test manually, run:"
echo "   deno task atlas signal trigger manual-analysis --workspace $WORKSPACE_PATH --data '{\"type\": \"comprehensive\"}'"
echo ""
echo "Starting server now..."

# Execute the workspace server
exec deno task atlas workspace serve --workspace "$WORKSPACE_PATH"