#!/bin/bash

# Test script for Atlas K8s Assistant Workspace (Atlas 2.0)
# This script validates the workspace configuration and connectivity

set -e

echo "🧪 Testing Atlas K8s Assistant Workspace Configuration (Atlas 2.0)"
echo "=================================================================="
echo ""

# Navigate to Atlas root for CLI commands
SCRIPT_DIR="$(dirname "$0")"
ATLAS_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"
WORKSPACE_NAME="k8s-assistant"

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
files=("README.md" "workspace.yml" "setup.sh" "start-workspace.sh" "scripts/deploy-nginx.sh" "scripts/troubleshoot.sh")

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
for script in scripts/*.sh setup.sh start-workspace.sh; do
    if [ -f "$script" ] && [ -x "$script" ]; then
        echo "   ✅ $script is executable"
    elif [ -f "$script" ]; then
        echo "   ❌ $script is not executable"
        exit 1
    fi
done

# Test 4: Check if Atlas CLI is available
echo "4. Checking Atlas CLI availability..."
cd "$ATLAS_ROOT"
if [ -f "src/cli.tsx" ]; then
    echo "   ✅ Atlas CLI found at src/cli.tsx"
    # Test if Deno can run the CLI
    if deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file src/cli.tsx version >/dev/null 2>&1; then
        echo "   ✅ Atlas CLI is functional"
    else
        echo "   ⚠️  Atlas CLI may have issues (check environment)"
    fi
else
    echo "   ❌ Atlas CLI not found"
    exit 1
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

if command -v deno >/dev/null 2>&1; then
    echo "   ✅ Deno is available"
    deno --version | head -1 | sed 's/^/   /'
else
    echo "   ❌ Deno is required but not found"
    exit 1
fi

# Test 6: Check Atlas daemon status
echo "6. Checking Atlas daemon status..."
if deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file src/cli.tsx daemon status >/dev/null 2>&1; then
    echo "   ✅ Atlas daemon is running"
    
    # Test 7: Check workspace status
    echo "7. Checking workspace status..."
    if deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file src/cli.tsx workspace status "$WORKSPACE_NAME" >/dev/null 2>&1; then
        echo "   ✅ Workspace $WORKSPACE_NAME is registered"
    else
        echo "   ⚠️  Workspace $WORKSPACE_NAME is not registered"
        echo "   Run: ./start-workspace.sh to register it"
    fi
else
    echo "   ⚠️  Atlas daemon is not running"
    echo "   Run: ./start-workspace.sh to start it"
fi

echo ""
echo "🎉 Workspace configuration test completed!"
echo ""
echo "📋 Next steps (Atlas 2.0):"
echo "1. Start your standalone coordinator agent:"
echo "   Start your k8s agent on port 8085"
echo "   Ensure it provides /health endpoint and ACP protocol support"
echo ""
echo "2. Start Atlas workspace (daemon-based):"
echo "   ./start-workspace.sh"
echo ""
echo "3. Test the Linear webhook signal:"
echo "   curl -X POST http://localhost:8080/signals/linear-webhook \\"
echo "     -H 'Content-Type: application/json' \\"
echo "     -H 'Linear-Event: Issue' \\"
echo "     -d '{\"action\": \"create\", \"data\": {\"type\": \"Issue\", \"title\": \"Test\"}}'"
echo ""
echo "4. Or trigger via CLI:"
echo "   atlas signal trigger linear-webhook --workspace k8s-assistant --data '{\"action\": \"create\"}'"
echo ""
echo "5. Monitor sessions:"
echo "   atlas ps"
echo ""
echo "📖 See README.md for detailed Atlas 2.0 usage instructions" 