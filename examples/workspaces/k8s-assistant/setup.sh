#!/bin/bash

# Setup script for Atlas K8s Assistant Workspace
# This script creates the necessary files and makes them executable

set -e

echo "🔧 Setting up Atlas K8s Assistant Workspace..."

# Create scripts directory if it doesn't exist
mkdir -p scripts

# Create deploy-nginx.sh
cat > scripts/deploy-nginx.sh << 'EOF'
#!/bin/bash

# Deploy nginx using Atlas workspace
# This script demonstrates how to use the k8s assistant workspace to deploy nginx

set -e

WORKSPACE_URL="http://localhost:3000"

echo "🚀 Deploying nginx using Atlas K8s Assistant..."

# Deploy nginx with 3 replicas and service
curl -X POST "${WORKSPACE_URL}/deploy" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Deploy nginx web server with 3 replicas, expose it on port 80 with a LoadBalancer service, and add resource limits of 100m CPU and 128Mi memory"
  }' | jq '.'

echo ""
echo "✅ Nginx deployment request sent!"
echo "💡 You can check the deployment status with:"
echo "   curl -X POST ${WORKSPACE_URL}/list -H 'Content-Type: application/json' -d '{\"message\": \"List all deployments and services\"}'"
EOF

# Create deploy-web-app.sh
cat > scripts/deploy-web-app.sh << 'EOF'
#!/bin/bash

# Deploy a complete web application stack using Atlas workspace
# This script demonstrates deploying a web app with database

set -e

WORKSPACE_URL="http://localhost:3000"
APP_NAME="${1:-web-app}"

echo "🚀 Deploying ${APP_NAME} stack using Atlas K8s Assistant..."

# Deploy the database first
echo "📦 Deploying PostgreSQL database..."
curl -X POST "${WORKSPACE_URL}/deploy" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Deploy PostgreSQL database with persistent storage, create a PVC of 10Gi, set POSTGRES_DB to ${APP_NAME}, POSTGRES_USER to app_user, and POSTGRES_PASSWORD to secure_password. Use postgres:13 image.\"
  }" | jq '.'

echo ""
echo "⏳ Waiting 30 seconds for database to initialize..."
sleep 30

# Deploy the web application
echo "🌐 Deploying web application..."
curl -X POST "${WORKSPACE_URL}/deploy" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Deploy a web application called ${APP_NAME} using httpd:2.4 image with 2 replicas, expose it on port 80, create a LoadBalancer service, and add environment variables to connect to PostgreSQL database with hostname postgres-service\"
  }" | jq '.'

echo ""
echo "✅ ${APP_NAME} stack deployment request sent!"
echo ""
echo "📋 Next steps:"
echo "1. Check deployment status:"
echo "   curl -X POST ${WORKSPACE_URL}/list -H 'Content-Type: application/json' -d '{\"message\": \"Show all deployments, services, and pods with their status\"}'"
echo ""
echo "2. Get service endpoints:"
echo "   curl -X POST ${WORKSPACE_URL}/list -H 'Content-Type: application/json' -d '{\"message\": \"List all services and their external IPs\"}'"
echo ""
echo "3. Troubleshoot if needed:"
echo "   curl -X POST ${WORKSPACE_URL}/troubleshoot -H 'Content-Type: application/json' -d '{\"message\": \"Check if all pods are running and healthy\"}'"
EOF

# Create scale-deployment.sh
cat > scripts/scale-deployment.sh << 'EOF'
#!/bin/bash

# Scale deployment using Atlas workspace
# Usage: ./scale-deployment.sh <deployment-name> <replicas>

set -e

WORKSPACE_URL="http://localhost:3000"
DEPLOYMENT_NAME="${1:-nginx}"
REPLICAS="${2:-3}"

if [ -z "$1" ]; then
    echo "Usage: $0 <deployment-name> [replicas]"
    echo "Example: $0 nginx 5"
    echo "Example: $0 web-app 2"
    exit 1
fi

echo "📈 Scaling ${DEPLOYMENT_NAME} to ${REPLICAS} replicas using Atlas K8s Assistant..."

# Scale the deployment
curl -X POST "${WORKSPACE_URL}/scale" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"Scale the ${DEPLOYMENT_NAME} deployment to ${REPLICAS} replicas and wait for all pods to be ready\"
  }" | jq '.'

echo ""
echo "✅ Scaling request sent!"
echo "💡 Monitor the scaling progress with:"
echo "   curl -X POST ${WORKSPACE_URL}/list -H 'Content-Type: application/json' -d '{\"message\": \"Show ${DEPLOYMENT_NAME} deployment status and pod count\"}'"
EOF

# Create troubleshoot.sh
cat > scripts/troubleshoot.sh << 'EOF'
#!/bin/bash

# Troubleshoot Kubernetes issues using Atlas workspace
# Usage: ./troubleshoot.sh [specific-issue]

set -e

WORKSPACE_URL="http://localhost:3000"
ISSUE="${1:-general}"

echo "🔍 Running Kubernetes troubleshooting using Atlas K8s Assistant..."

case "$ISSUE" in
    "pods")
        MESSAGE="Check all pods across all namespaces, identify any that are not in Running state, and provide detailed analysis of any issues found"
        ;;
    "deployments")
        MESSAGE="Analyze all deployments and their replica status, identify any that are not ready, and suggest fixes"
        ;;
    "services")
        MESSAGE="Check all services and their endpoints, verify connectivity, and identify any networking issues"
        ;;
    "storage")
        MESSAGE="Check persistent volumes and persistent volume claims, identify any storage issues or failed mounts"
        ;;
    "resources")
        MESSAGE="Analyze resource usage across the cluster, identify pods with high CPU or memory usage, and suggest optimizations"
        ;;
    "events")
        MESSAGE="Show recent Kubernetes events, focus on warnings and errors, and provide analysis of any concerning patterns"
        ;;
    *)
        MESSAGE="Perform a comprehensive cluster health check, identify any issues with pods, deployments, services, or resources, and provide actionable recommendations"
        ;;
esac

echo "🔧 Issue type: $ISSUE"
echo "🎯 Analysis: $MESSAGE"
echo ""

# Run troubleshooting
curl -X POST "${WORKSPACE_URL}/troubleshoot" \
  -H "Content-Type: application/json" \
  -d "{
    \"message\": \"$MESSAGE\"
  }" | jq '.'

echo ""
echo "✅ Troubleshooting analysis complete!"
echo ""
echo "💡 Available troubleshooting modes:"
echo "   ./troubleshoot.sh pods         - Check pod status"
echo "   ./troubleshoot.sh deployments  - Check deployment status"
echo "   ./troubleshoot.sh services     - Check service connectivity"
echo "   ./troubleshoot.sh storage      - Check storage issues"
echo "   ./troubleshoot.sh resources    - Check resource usage"
echo "   ./troubleshoot.sh events       - Check recent events"
echo "   ./troubleshoot.sh              - General health check"
EOF

# Create quick-start.sh
cat > scripts/quick-start.sh << 'EOF'
#!/bin/bash

# Quick start script for Atlas K8s Assistant Workspace
# This script helps you get started with the workspace

set -e

WORKSPACE_URL="http://localhost:3000"
K8S_AGENT_URL="http://localhost:8080"

echo "🚀 Atlas K8s Assistant Workspace - Quick Start"
echo "=============================================="
echo ""

# Check if k8s agent is running
echo "1. Checking K8s Main Agent connectivity..."
if curl -s "${K8S_AGENT_URL}/health" > /dev/null 2>&1; then
    echo "   ✅ K8s Main Agent is running at ${K8S_AGENT_URL}"
else
    echo "   ❌ K8s Main Agent is not running at ${K8S_AGENT_URL}"
    echo ""
    echo "   Please start the k8s-deployment-demo main agent first:"
    echo "   cd k8s-deployment-demo"
    echo "   export GEMINI_API_KEY=\"your_api_key_here\""
    echo "   make start-agents"
    echo ""
    exit 1
fi

# Check if Atlas workspace is running
echo "2. Checking Atlas Workspace connectivity..."
if curl -s "${WORKSPACE_URL}/health" > /dev/null 2>&1; then
    echo "   ✅ Atlas Workspace is running at ${WORKSPACE_URL}"
else
    echo "   ❌ Atlas Workspace is not running at ${WORKSPACE_URL}"
    echo ""
    echo "   Please start the Atlas workspace first:"
    echo "   atlas workspace serve"
    echo ""
    exit 1
fi

# Check kubectl access
echo "3. Checking kubectl access..."
if kubectl cluster-info > /dev/null 2>&1; then
    echo "   ✅ kubectl is configured and cluster is accessible"
else
    echo "   ❌ kubectl is not configured or cluster is not accessible"
    echo "   Please configure kubectl to access your Kubernetes cluster"
    exit 1
fi

echo ""
echo "🎉 All systems are ready!"
echo ""
echo "💡 Try these example commands:"
echo ""

# Run a quick test
echo "4. Running a quick test..."
echo "   Testing workspace connectivity with a simple list command..."
curl -s -X POST "${WORKSPACE_URL}/list" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "List all namespaces in the cluster"
  }' | jq '.' | head -20

echo ""
echo "✅ Quick test completed!"
echo ""
echo "📋 Available example scripts:"
echo "   ./scripts/deploy-nginx.sh           - Deploy nginx with 3 replicas"
echo "   ./scripts/deploy-web-app.sh [name]  - Deploy a web app stack"
echo "   ./scripts/scale-deployment.sh <name> <replicas> - Scale a deployment"
echo "   ./scripts/troubleshoot.sh [issue]   - Troubleshoot cluster issues"
echo ""
echo "🌐 Available HTTP endpoints:"
echo "   POST ${WORKSPACE_URL}/deploy       - Create deployments"
echo "   POST ${WORKSPACE_URL}/scale        - Scale deployments"
echo "   POST ${WORKSPACE_URL}/list         - List resources"
echo "   POST ${WORKSPACE_URL}/troubleshoot - Troubleshoot issues"
echo "   POST ${WORKSPACE_URL}/assist       - General assistance"
echo "   GET  ${WORKSPACE_URL}/health       - Health check"
echo ""
echo "🎯 Example curl commands:"
echo ""
echo "Deploy nginx:"
echo "curl -X POST ${WORKSPACE_URL}/deploy -H 'Content-Type: application/json' -d '{\"message\": \"Deploy nginx with 3 replicas\"}'"
echo ""
echo "List all pods:"
echo "curl -X POST ${WORKSPACE_URL}/list -H 'Content-Type: application/json' -d '{\"message\": \"List all pods\"}'"
echo ""
echo "🎊 Happy Kubernetes management with Atlas!"
EOF

# Make all scripts executable
chmod +x scripts/*.sh

echo "✅ Created and made executable:"
echo "   - scripts/deploy-nginx.sh"
echo "   - scripts/deploy-web-app.sh"  
echo "   - scripts/scale-deployment.sh"
echo "   - scripts/troubleshoot.sh"
echo "   - scripts/quick-start.sh"
echo ""
echo "🚀 To get started:"
echo "1. Start your k8s-deployment-demo main agent (port 8080)"
echo "2. Start Atlas workspace: atlas workspace serve"
echo "3. Run: ./scripts/quick-start.sh"
echo ""
echo "📖 See README.md for detailed usage instructions" 