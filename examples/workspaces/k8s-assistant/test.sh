#!/bin/bash

# Test script for Atlas K8s Assistant Workspace
# This script validates the workspace configuration and connectivity

set -e

echo "🧪 Testing Atlas K8s Assistant Workspace Configuration"
echo "====================================================="
echo ""

# Test 1: Validate workspace.yml syntax
echo "1. Validating workspace.yml syntax..."
if command -v yq >/dev/null 2>&1; then
    yq eval . workspace.yml > /dev/null
    echo "   ✅ workspace.yml syntax is valid"
else
    echo "   ⚠️  yq not found, skipping YAML validation"
fi

# Test 2: Check if required files exist
echo "2. Checking required files..."
files=("README.md" "workspace.yml" "setup.sh" "scripts/deploy-nginx.sh" "scripts/deploy-web-app.sh" "scripts/scale-deployment.sh" "scripts/troubleshoot.sh" "scripts/quick-start.sh")

for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "   ✅ $file exists"
    else
        echo "   ❌ $file missing"
        exit 1
    fi
done

# Test 3: Check script permissions
echo "3. Checking script permissions..."
for script in scripts/*.sh; do
    if [ -x "$script" ]; then
        echo "   ✅ $script is executable"
    else
        echo "   ❌ $script is not executable"
        exit 1
    fi
done

# Test 4: Check if Atlas command is available
echo "4. Checking Atlas availability..."
if command -v atlas >/dev/null 2>&1; then
    echo "   ✅ Atlas command is available"
    atlas --version 2>/dev/null | head -1 | sed 's/^/   /'
else
    echo "   ⚠️  Atlas command not found in PATH"
    echo "   Please install Atlas first: https://github.com/atlas-comms/atlas"
fi

# Test 5: Check if curl and jq are available
echo "5. Checking dependencies..."
if command -v curl >/dev/null 2>&1; then
    echo "   ✅ curl is available"
else
    echo "   ❌ curl is required but not found"
    exit 1
fi

if command -v jq >/dev/null 2>&1; then
    echo "   ✅ jq is available"
else
    echo "   ⚠️  jq is recommended for JSON processing"
fi

if command -v kubectl >/dev/null 2>&1; then
    echo "   ✅ kubectl is available"
    kubectl version --client=true 2>/dev/null | head -1 | sed 's/^/   /'
else
    echo "   ⚠️  kubectl not found - required for Kubernetes operations"
fi

echo ""
echo "🎉 Workspace configuration test completed!"
echo ""
echo "📋 Next steps:"
echo "1. Start your k8s-deployment-demo main agent:"
echo "   cd k8s-deployment-demo"
echo "   export GEMINI_API_KEY=\"your_api_key_here\""
echo "   make start-agents"
echo ""
echo "2. Start Atlas workspace (in another terminal):"
echo "   atlas workspace serve"
echo ""
echo "3. Run the quick start script:"
echo "   ./scripts/quick-start.sh"
echo ""
echo "4. Or manually test an endpoint:"
echo "   curl -X POST http://localhost:3000/assist -H 'Content-Type: application/json' -d '{\"message\": \"Hello k8s assistant!\"}'"
echo ""
echo "📖 See README.md for detailed usage instructions" 