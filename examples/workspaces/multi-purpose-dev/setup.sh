#!/bin/bash

# Multi-Purpose Development Workspace Setup Script

set -e

echo "🚀 Setting up Multi-Purpose Development Workspace..."

# Create necessary directories
mkdir -p ~/.atlas/logs/workspaces

# Check if required environment file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Creating .env template file..."
    cat > .env << 'EOF'
# GitHub Integration
GITHUB_TOKEN=your_github_token_here

# Database Connection
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database_name
DB_USER=your_username
DB_PASSWORD=your_password

# Slack Integration  
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your_signing_secret_here

# AWS Credentials
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
AWS_DEFAULT_REGION=us-east-1

# CI/CD Integration
CIRCLECI_API_TOKEN=your_circleci_token_here

# Error Tracking
SENTRY_AUTH_TOKEN=your_sentry_token_here

# Anthropic API Key (for LLM agents)
ANTHROPIC_API_KEY=your_anthropic_api_key_here
EOF
    echo "📝 .env file created. Please update with your actual credentials."
else
    echo "✅ .env file already exists"
fi

# Validate workspace configuration
echo "🔍 Validating workspace configuration..."

# Basic file existence and structure check
if [ -f "workspace.yml" ]; then
    echo "✅ workspace.yml exists"
    
    # Basic YAML structure validation using grep
    if grep -q "^version:" workspace.yml && \
       grep -q "^workspace:" workspace.yml && \
       grep -q "^jobs:" workspace.yml && \
       grep -q "^signals:" workspace.yml; then
        echo "✅ Workspace configuration structure is valid"
        
        # Count jobs and signals
        job_count=$(grep -c "^  [a-zA-Z-]*:" workspace.yml | grep -v "^  #" || echo "0")
        signal_count=$(grep -A 1000 "^signals:" workspace.yml | grep -c "^  [a-zA-Z-]*:" || echo "0")
        echo "📊 Found approximately $job_count jobs and $signal_count signals"
    else
        echo "❌ workspace.yml missing required sections (version, workspace, jobs, signals)"
        exit 1
    fi
else
    echo "❌ workspace.yml not found"
    exit 1
fi

# Check job specifications
echo "🔍 Checking job specifications..."
job_count=0
for job_file in jobs/*.yml; do
    if [ -f "$job_file" ]; then
        job_count=$((job_count + 1))
        echo "  ✅ Found job: $(basename "$job_file" .yml)"
    fi
done

echo "📊 Total jobs configured: $job_count"

# Create startup script
echo "📝 Creating startup script..."
cat > start-workspace.sh << 'EOF'
#!/bin/bash

# Start Multi-Purpose Development Workspace

echo "🚀 Starting Multi-Purpose Development Workspace..."

# Load environment variables
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
    echo "✅ Environment variables loaded"
else
    echo "❌ .env file not found"
    exit 1
fi

# Start Atlas workspace server
echo "🖥️  Starting Atlas workspace server..."
exec atlas workspace serve
EOF

chmod +x start-workspace.sh

# Create test script
echo "📝 Creating test script..."
cat > test-signals.sh << 'EOF'
#!/bin/bash

# Test Multi-Purpose Development Workspace Signals

echo "🧪 Testing workspace signals..."

# Test code review request
echo "📝 Testing code review request..."
atlas signal trigger code-review-request '{
  "files": ["README.md", "workspace.yml"],
  "focus_areas": ["documentation", "configuration"]
}'

# Test file operation
echo "📁 Testing file operation..."
atlas signal trigger file-operation-request '{
  "operation": "read",
  "path": "./README.md"
}'

# Test research request
echo "🔍 Testing research request..."
atlas signal trigger research-request '{
  "topic": "Atlas workspace configuration",
  "focus_areas": ["best-practices", "examples"]
}'

echo "✅ Test signals completed"
EOF

chmod +x test-signals.sh

echo ""
echo "✅ Setup completed successfully!"
echo ""
echo "Next steps:"
echo "1. Update .env file with your actual credentials"
echo "2. Run: ./start-workspace.sh"
echo "3. Test with: ./test-signals.sh"
echo ""
echo "📚 See README.md for detailed usage instructions"