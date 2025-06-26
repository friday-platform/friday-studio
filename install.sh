#!/bin/bash

# Atlas Installation Script
# Installs Atlas as a local dev tool

set -e

echo "🚀 Installing Atlas - AI Agent Orchestration Platform"
echo "=================================================="

# Check if Deno is installed
if ! command -v deno &> /dev/null; then
    echo "❌ Deno is not installed. Please install Deno first:"
    echo "   curl -fsSL https://deno.land/x/install/install.sh | sh"
    exit 1
fi

echo "✅ Deno found: $(deno --version | head -1)"

# Install Atlas CLI globally via Deno
echo "📦 Installing Atlas CLI..."
deno install --global --allow-read --allow-write --allow-net -f -n atlas src/cli.tsx

echo ""
echo "✅ Atlas installed successfully!"
echo ""
echo "📖 Quick Start:"
echo "   atlas help                    # Show help"
echo "   atlas create my-project       # Create a workspace" 
echo "   atlas list                    # List workspaces"
echo "   atlas ps                      # List active sessions"
echo ""
echo "📁 Workspaces will be stored in: ~/.atlas/"
echo ""
echo "🎉 Atlas is ready to orchestrate your AI agents!"