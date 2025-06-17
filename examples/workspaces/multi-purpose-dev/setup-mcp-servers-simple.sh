#!/bin/bash

# Simple and Robust MCP Servers Setup for Multi-Purpose Development Workspace
# This script creates working MCP servers with minimal dependencies

set -e

echo "🚀 Setting up Simple MCP Servers for Multi-Purpose Development Workspace..."

# Create MCP servers directory
MCP_DIR="$HOME/.atlas/mcp-servers"
WORKSPACE_MCP_DIR="$(pwd)/mcp-servers"
mkdir -p "$MCP_DIR"
mkdir -p "$WORKSPACE_MCP_DIR"
mkdir -p "$WORKSPACE_MCP_DIR/logs"

# Function to check if Node.js is installed
check_nodejs() {
    if ! command -v node >/dev/null 2>&1; then
        echo "❌ Node.js is not installed. Please install Node.js first."
        echo "   Visit: https://nodejs.org/"
        exit 1
    fi
    echo "✅ Node.js found: $(node --version)"
}

# Function to create a generic MCP server template
create_mcp_server() {
    local server_name=$1
    local port=$2
    local description=$3
    
    echo "📦 Creating $server_name MCP Server..."
    
    local server_dir="$MCP_DIR/$server_name"
    mkdir -p "$server_dir"
    cd "$server_dir"
    
    # Create package.json
    cat > package.json << EOF
{
  "name": "$server_name",
  "version": "1.0.0",
  "description": "$description",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5"
  }
}
EOF
    
    # Create basic server
    cat > index.js << EOF
// $description
const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || $port;

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        server: '$server_name',
        port: port,
        timestamp: new Date().toISOString()
    });
});

// Main MCP endpoint
app.post('/mcp', async (req, res) => {
    try {
        console.log(\`[\${new Date().toISOString()}] $server_name MCP request:\`, req.body);
        
        const { action, payload } = req.body;
        let result = {};
        
        // Server-specific actions will be added here
        switch (action) {
            case 'ping':
                result = { message: 'pong', server: '$server_name' };
                break;
            case 'status':
                result = { 
                    status: 'operational',
                    server: '$server_name',
                    capabilities: ['ping', 'status'],
                    timestamp: new Date().toISOString()
                };
                break;
            default:
                result = { 
                    message: \`$server_name - Action '\${action}' not implemented yet\`,
                    server: '$server_name',
                    action: action,
                    available_actions: ['ping', 'status']
                };
        }
        
        res.json({ 
            status: 'success', 
            server: '$server_name',
            data: result 
        });
    } catch (error) {
        console.error(\`$server_name MCP error:\`, error);
        res.status(500).json({ 
            status: 'error', 
            server: '$server_name',
            message: error.message 
        });
    }
});

app.listen(port, () => {
    console.log(\`✅ $server_name running on port \${port}\`);
    console.log(\`📡 Health check: http://localhost:\${port}/health\`);
    console.log(\`🔗 MCP endpoint: http://localhost:\${port}/mcp\`);
    console.log(\`📋 Available actions: ping, status\`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log(\`🛑 $server_name shutting down...\`);
    process.exit(0);
});
EOF
    
    # Install dependencies
    npm install --silent
    echo "✅ $server_name MCP Server created"
}

# Function to create enhanced servers with specific functionality
create_enhanced_servers() {
    # GitHub MCP Server with Octokit
    echo "📦 Creating enhanced GitHub MCP Server..."
    local github_dir="$MCP_DIR/github-mcp"
    mkdir -p "$github_dir"
    cd "$github_dir"
    
    cat > package.json << 'EOF'
{
  "name": "github-mcp",
  "version": "1.0.0",
  "description": "GitHub MCP Server with Octokit",
  "main": "index.js",
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5",
    "@octokit/rest": "^20.0.0"
  }
}
EOF
    
    cat > index.js << 'EOF'
// GitHub MCP Server with Octokit
const express = require('express');
const cors = require('cors');
const { Octokit } = require('@octokit/rest');
const app = express();
const port = process.env.PORT || 3020;

app.use(cors());
app.use(express.json());

// Initialize Octokit (will work if GITHUB_TOKEN is set)
let octokit = null;
if (process.env.GITHUB_TOKEN) {
    octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    console.log('✅ GitHub authentication configured');
} else {
    console.log('⚠️  GITHUB_TOKEN not set - limited functionality');
}

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        server: 'github-mcp',
        authenticated: !!octokit,
        port: port,
        timestamp: new Date().toISOString()
    });
});

app.post('/mcp', async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] GitHub MCP request:`, req.body);
        
        const { action, payload } = req.body;
        let result = {};
        
        if (!octokit && ['list_repos', 'get_repo', 'create_repo'].includes(action)) {
            return res.status(401).json({
                status: 'error',
                message: 'GitHub token required for this action',
                action: action
            });
        }
        
        switch (action) {
            case 'ping':
                result = { message: 'pong', server: 'github-mcp' };
                break;
                
            case 'list_repos':
                const repos = await octokit.rest.repos.listForAuthenticatedUser({
                    sort: 'updated',
                    per_page: payload?.limit || 10
                });
                result = { 
                    repos: repos.data.map(repo => ({
                        name: repo.name,
                        full_name: repo.full_name,
                        description: repo.description,
                        url: repo.html_url,
                        private: repo.private,
                        updated_at: repo.updated_at
                    }))
                };
                break;
                
            case 'get_repo':
                if (!payload?.owner || !payload?.repo) {
                    throw new Error('owner and repo are required');
                }
                const repo = await octokit.rest.repos.get({
                    owner: payload.owner,
                    repo: payload.repo
                });
                result = { repo: repo.data };
                break;
                
            default:
                result = { 
                    message: `GitHub MCP - Action '${action}' not implemented`,
                    available_actions: ['ping', 'list_repos', 'get_repo']
                };
        }
        
        res.json({ 
            status: 'success', 
            server: 'github-mcp',
            data: result 
        });
    } catch (error) {
        console.error('GitHub MCP error:', error);
        res.status(500).json({ 
            status: 'error', 
            server: 'github-mcp',
            message: error.message 
        });
    }
});

app.listen(port, () => {
    console.log(`✅ GitHub MCP Server running on port ${port}`);
    console.log(`📡 Health check: http://localhost:${port}/health`);
    console.log(`🔗 MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`📋 Available actions: ping, list_repos, get_repo`);
});
EOF
    
    npm install --silent
    echo "✅ Enhanced GitHub MCP Server created"
    
    # Filesystem MCP Server with fs-extra
    echo "📁 Creating enhanced Filesystem MCP Server..."
    local fs_dir="$MCP_DIR/filesystem-mcp"
    mkdir -p "$fs_dir"
    cd "$fs_dir"
    
    cat > package.json << 'EOF'
{
  "name": "filesystem-mcp",
  "version": "1.0.0",
  "description": "Filesystem MCP Server with fs-extra",
  "main": "index.js",
  "dependencies": {
    "express": "^4.18.0",
    "cors": "^2.8.5",
    "fs-extra": "^11.0.0"
  }
}
EOF
    
    cat > index.js << 'EOF'
// Filesystem MCP Server with fs-extra
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const app = express();
const port = process.env.PORT || 3021;

app.use(cors());
app.use(express.json());

// Security: Define allowed paths (can be configured via env)
const ALLOWED_PATHS = process.env.ALLOWED_PATHS ? 
    process.env.ALLOWED_PATHS.split(',') : 
    [process.cwd(), '/tmp'];

function isPathAllowed(filePath) {
    const absolutePath = path.resolve(filePath);
    return ALLOWED_PATHS.some(allowedPath => 
        absolutePath.startsWith(path.resolve(allowedPath))
    );
}

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        server: 'filesystem-mcp',
        allowed_paths: ALLOWED_PATHS,
        port: port,
        timestamp: new Date().toISOString()
    });
});

app.post('/mcp', async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Filesystem MCP request:`, req.body);
        
        const { action, payload } = req.body;
        let result = {};
        
        switch (action) {
            case 'ping':
                result = { message: 'pong', server: 'filesystem-mcp' };
                break;
                
            case 'read_file':
                if (!payload?.path) throw new Error('path is required');
                if (!isPathAllowed(payload.path)) throw new Error('Path not allowed');
                
                const content = await fs.readFile(payload.path, 'utf8');
                result = { 
                    content: content,
                    path: payload.path,
                    size: content.length
                };
                break;
                
            case 'list_directory':
                if (!payload?.path) throw new Error('path is required');
                if (!isPathAllowed(payload.path)) throw new Error('Path not allowed');
                
                const files = await fs.readdir(payload.path, { withFileTypes: true });
                result = { 
                    files: files.map(file => ({
                        name: file.name,
                        type: file.isDirectory() ? 'directory' : 'file',
                        path: path.join(payload.path, file.name)
                    })),
                    path: payload.path
                };
                break;
                
            case 'file_exists':
                if (!payload?.path) throw new Error('path is required');
                if (!isPathAllowed(payload.path)) throw new Error('Path not allowed');
                
                const exists = await fs.pathExists(payload.path);
                result = { exists, path: payload.path };
                break;
                
            default:
                result = { 
                    message: `Filesystem MCP - Action '${action}' not implemented`,
                    available_actions: ['ping', 'read_file', 'list_directory', 'file_exists']
                };
        }
        
        res.json({ 
            status: 'success', 
            server: 'filesystem-mcp',
            data: result 
        });
    } catch (error) {
        console.error('Filesystem MCP error:', error);
        res.status(500).json({ 
            status: 'error', 
            server: 'filesystem-mcp',
            message: error.message 
        });
    }
});

app.listen(port, () => {
    console.log(`✅ Filesystem MCP Server running on port ${port}`);
    console.log(`📡 Health check: http://localhost:${port}/health`);
    console.log(`🔗 MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`📋 Available actions: ping, read_file, list_directory, file_exists`);
    console.log(`🔒 Allowed paths: ${ALLOWED_PATHS.join(', ')}`);
});
EOF
    
    npm install --silent
    echo "✅ Enhanced Filesystem MCP Server created"
}

# Function to create startup scripts
create_startup_scripts() {
    echo "📝 Creating startup scripts..."
    
    # Ensure workspace MCP directory exists
    mkdir -p "$WORKSPACE_MCP_DIR"
    mkdir -p "$WORKSPACE_MCP_DIR/logs"
    
    # Individual server startup scripts
    local servers=(
        "github-mcp:3020"
        "filesystem-mcp:3021"
        "postgresql-mcp:3022"
        "fetch-mcp:3023"
        "slack-mcp:3024"
        "memory-mcp:3025"
        "aws-mcp:3026"
        "circleci-mcp:3027"
        "sentry-mcp:3028"
    )
    
    for server_info in "${servers[@]}"; do
        IFS=':' read -r server_name port <<< "$server_info"
        
        cat > "$WORKSPACE_MCP_DIR/start-${server_name}.sh" << EOF
#!/bin/bash
cd ~/.atlas/mcp-servers/${server_name}
export PORT=${port}

# Load environment variables if available
ENV_FILE=""
for possible_env in "../../../.env" "../../../../.env" "../../../../../.env"; do
    if [ -f "\$possible_env" ]; then
        ENV_FILE="\$possible_env"
        break
    fi
done

if [ ! -z "\$ENV_FILE" ]; then
    export \$(grep -v '^#' "\$ENV_FILE" | xargs) 2>/dev/null || true
    echo "✅ Environment loaded from \$ENV_FILE"
else
    echo "⚠️  .env file not found, using defaults"
fi

echo "🚀 Starting ${server_name} on port ${port}..."

# Check if the server directory exists and has index.js
if [ ! -f "index.js" ]; then
    echo "❌ index.js not found in ~/.atlas/mcp-servers/${server_name}"
    echo "Available files:"
    ls -la
    exit 1
fi

node index.js
EOF
        chmod +x "$WORKSPACE_MCP_DIR/start-${server_name}.sh"
    done
    
    # Master startup script
    cat > "$WORKSPACE_MCP_DIR/start-all-mcp.sh" << 'EOF'
#!/bin/bash

echo "🚀 Starting all MCP servers..."

# Load environment variables
if [ -f "../.env" ]; then
    export $(grep -v '^#' ../.env | xargs) 2>/dev/null || true
    echo "✅ Environment variables loaded"
else
    echo "⚠️  .env file not found - some servers may have limited functionality"
fi

# Array of MCP servers with ports
declare -A MCP_SERVERS
MCP_SERVERS[github-mcp]=3020
MCP_SERVERS[filesystem-mcp]=3021
MCP_SERVERS[postgresql-mcp]=3022
MCP_SERVERS[fetch-mcp]=3023
MCP_SERVERS[slack-mcp]=3024
MCP_SERVERS[memory-mcp]=3025
MCP_SERVERS[aws-mcp]=3026
MCP_SERVERS[circleci-mcp]=3027
MCP_SERVERS[sentry-mcp]=3028

# Start each MCP server in background
for server in "${!MCP_SERVERS[@]}"; do
    port=${MCP_SERVERS[$server]}
    echo "🔄 Starting $server on port $port..."
    
    # Check if port is already in use
    if lsof -i :$port >/dev/null 2>&1; then
        echo "⚠️  Port $port already in use, skipping $server"
        continue
    fi
    
    if [ -f "./start-${server}.sh" ]; then
        ./start-${server}.sh > "./logs/${server}.log" 2>&1 &
        SERVER_PID=$!
        echo "  └─ PID: $SERVER_PID"
        
        # Give server time to start
        sleep 2
        
        # Test if server started successfully
        if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
            echo "  ✅ $server started successfully"
        else
            echo "  ⚠️  $server may have failed to start (check logs/${server}.log)"
        fi
    else
        echo "  ❌ Startup script for $server not found"
    fi
done

echo ""
echo "✅ MCP server startup completed"
echo "📋 Check status: curl http://localhost:PORT/health"
echo "🛑 Stop all: ./stop-all-mcp.sh"
echo "📄 View logs: tail -f logs/*.log"
EOF
    chmod +x "$WORKSPACE_MCP_DIR/start-all-mcp.sh"
    
    # Stop script
    cat > "$WORKSPACE_MCP_DIR/stop-all-mcp.sh" << 'EOF'
#!/bin/bash

echo "🛑 Stopping all MCP servers..."

# Kill by port
for port in 3020 3021 3022 3023 3024 3025 3026 3027 3028; do
    PID=$(lsof -ti :$port 2>/dev/null)
    if [ ! -z "$PID" ]; then
        echo "🔄 Stopping server on port $port (PID: $PID)"
        kill $PID 2>/dev/null || true
        sleep 1
    fi
done

# Fallback: kill by name pattern
pkill -f "mcp.*index.js" 2>/dev/null || true

echo "✅ All MCP servers stopped"
EOF
    chmod +x "$WORKSPACE_MCP_DIR/stop-all-mcp.sh"
    
    # Health check script
    cat > "$WORKSPACE_MCP_DIR/check-health.sh" << 'EOF'
#!/bin/bash

echo "🔍 Checking MCP server health..."

declare -A MCP_SERVERS
MCP_SERVERS[github-mcp]=3020
MCP_SERVERS[filesystem-mcp]=3021
MCP_SERVERS[postgresql-mcp]=3022
MCP_SERVERS[fetch-mcp]=3023
MCP_SERVERS[slack-mcp]=3024
MCP_SERVERS[memory-mcp]=3025
MCP_SERVERS[aws-mcp]=3026
MCP_SERVERS[circleci-mcp]=3027
MCP_SERVERS[sentry-mcp]=3028

for server in "${!MCP_SERVERS[@]}"; do
    port=${MCP_SERVERS[$server]}
    printf "%-20s " "$server:"
    
    if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
        echo "✅ Healthy (port $port)"
    else
        echo "❌ Not responding (port $port)"
    fi
done
EOF
    chmod +x "$WORKSPACE_MCP_DIR/check-health.sh"
}

# Main execution
main() {
    echo "🔍 Checking prerequisites..."
    check_nodejs
    
    echo ""
    echo "📦 Creating MCP servers..."
    
    # Create basic servers first
    create_mcp_server "postgresql-mcp" 3022 "PostgreSQL MCP Server"
    create_mcp_server "fetch-mcp" 3023 "Web Fetch MCP Server"
    create_mcp_server "slack-mcp" 3024 "Slack Communication MCP Server"
    create_mcp_server "memory-mcp" 3025 "Memory Management MCP Server"
    create_mcp_server "aws-mcp" 3026 "AWS Cloud MCP Server"
    create_mcp_server "circleci-mcp" 3027 "CircleCI MCP Server"
    create_mcp_server "sentry-mcp" 3028 "Sentry Error Tracking MCP Server"
    
    # Create enhanced servers
    create_enhanced_servers
    
    # Create startup scripts
    create_startup_scripts
    
    echo ""
    echo "✅ Simple MCP Server setup completed!"
    echo ""
    echo "📋 Next steps:"
    echo "1. Configure credentials in .env file"
    echo "2. Start all MCP servers: cd mcp-servers && ./start-all-mcp.sh"
    echo "3. Check health: cd mcp-servers && ./check-health.sh"
    echo "4. Start Atlas workspace: ./start-workspace.sh"
    echo "5. Test signals: ./test-signals.sh"
    echo ""
    echo "📁 MCP servers created in: $MCP_DIR"
    echo "🚀 Management scripts in: $WORKSPACE_MCP_DIR"
    echo "📄 Logs will be in: $WORKSPACE_MCP_DIR/logs/"
}

# Run main function
main "$@"