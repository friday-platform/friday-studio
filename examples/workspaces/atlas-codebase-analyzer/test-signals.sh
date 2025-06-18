#!/bin/bash

# Test signals for Atlas Codebase Analyzer
# Tests different analysis scenarios manually

set -e

echo "🧪 Atlas Codebase Analyzer - Signal Testing"
echo "============================================="

# Check if we're in the right directory
if [[ ! -f "workspace.yml" ]]; then
    echo "❌ Error: workspace.yml not found. Please run from the atlas-codebase-analyzer directory."
    exit 1
fi

# Add Atlas CLI to PATH for convenience
export PATH="/Users/kenneth/tempest/atlas:$PATH"

echo "📍 Testing workspace from: $(pwd)"
echo ""

# Test 1: Comprehensive Analysis
echo "🔍 Test 1: Comprehensive Analysis"
echo "Triggering comprehensive codebase analysis..."
cd /Users/kenneth/tempest/atlas && deno task atlas signal trigger manual-analysis \
  --data '{"type": "comprehensive", "scope": "full-codebase"}'

echo "✅ Comprehensive analysis triggered"
echo ""

# Test 2: Performance-focused Analysis  
echo "⚡ Test 2: Performance Analysis"
echo "Triggering performance-focused analysis..."
cd /Users/kenneth/tempest/atlas && deno task atlas signal trigger manual-analysis \
  --data '{"type": "performance", "focus": ["memory", "async", "llm-calls"]}'

echo "✅ Performance analysis triggered"
echo ""

# Test 3: Developer Experience Analysis
echo "👩‍💻 Test 3: Developer Experience Analysis" 
echo "Triggering DX-focused analysis..."
cd /Users/kenneth/tempest/atlas && deno task atlas signal trigger manual-analysis \
  --data '{"type": "dx", "focus": ["api-ergonomics", "error-messages", "documentation"]}'

echo "✅ Developer experience analysis triggered"
echo ""

# Test 4: Architecture Review
echo "🏗️  Test 4: Architecture Analysis"
echo "Triggering architecture review..."
cd /Users/kenneth/tempest/atlas && deno task atlas signal trigger manual-analysis \
  --data '{"type": "architecture", "focus": ["coupling", "security", "scalability"]}'

echo "✅ Architecture analysis triggered"
echo ""

# Check active sessions
echo "📊 Active Sessions:"
cd /Users/kenneth/tempest/atlas && deno task atlas session list

echo ""
echo "🎯 Testing Complete!"
echo ""
echo "💡 Next steps:"
echo "   1. Monitor sessions: cd /Users/kenneth/tempest/atlas && deno task atlas session list"
echo "   2. Check logs: tail -f ~/.atlas/logs/workspaces/f47ac10b-58cc-4372-a567-0e02b2c3d479.log"
echo "   3. View workspace status: cd /Users/kenneth/tempest/atlas && deno task atlas"
echo "   4. The workspace server is running on http://localhost:8080"