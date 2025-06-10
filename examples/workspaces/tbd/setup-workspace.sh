#!/bin/bash

# Setup workspace for telephone game

echo "Setting up Atlas workspace for Telephone Game..."

# Create workspace.yml
cat > workspace.yml << 'EOF'
version: "1.0"
workspace:
  id: "${WORKSPACE_ID}"
  name: "Telephone Game"
  description: "A game where messages transform through multiple agents"
supervisor:
  model: "claude-4-sonnet-20250514"
  prompts:
    system: |
      You are the WorkspaceSupervisor for a telephone game workspace.
      Your role is to coordinate agents that transform messages sequentially.
    intent: |
      You are coordinating a telephone game where a message passes through agents that:
      1. Mishear the message (mishearing-agent)
      2. Embellish it with details (embellishment-agent)  
      3. Reinterpret the meaning (reinterpretation-agent)
      
      Each agent should transform the message in their unique way.
    evaluation: |
      CRITICAL FOR TELEPHONE GAME:
      - The session is ONLY complete when ALL THREE agents have processed the message
      - You must see outputs from: mishearing-agent, embellishment-agent, AND reinterpretation-agent
      - Even if transformations seem complete, continue until all 3 agents have run
      - The telephone game requires the full chain of transformations
    session: |
      This is a telephone game session. The message must pass through ALL agents in sequence.
agents:
  mishearing-agent:
    type: "local"
    path: "./agents/mishearing-agent.ts"
    purpose: "Specializes in phonetic errors and mishearing"
    model: "claude-4-sonnet-20250514"
  embellishment-agent:
    type: "local"
    path: "./agents/embellishment-agent.ts"
    purpose: "Adds context and embellishes stories"
    model: "claude-4-sonnet-20250514"
  reinterpretation-agent:
    type: "local"
    path: "./agents/reinterpretation-agent.ts"
    purpose: "Dramatically transforms messages"
    model: "claude-4-sonnet-20250514"
signals:
  telephone-message:
    description: "Trigger a telephone game with a message"
    provider: "cli"
    schema:
      type: "object"
      properties:
        message:
          type: "string"
          description: "The message to transform"
      required: ["message"]
    mappings:
      - agents: ["mishearing-agent", "embellishment-agent", "reinterpretation-agent"]
        strategy: "sequential"
        prompt: |
          Process this message through all three agents in sequence.
          Each agent should transform the output of the previous one.
runtime:
  server:
    port: 8080
    host: "localhost"
  logging:
    level: "info"
    format: "pretty"
  persistence:
    type: "local"
    path: "./.atlas"
  security:
    cors: "*"
EOF

# Create .atlas directory
mkdir -p .atlas/sessions .atlas/logs

# Generate workspace ID
WORKSPACE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

# Create workspace metadata
cat > .atlas/workspace.json << EOF
{
  "id": "$WORKSPACE_ID",
  "name": "Telephone Game",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "version": "1.0.0"
}
EOF

# Update workspace.yml with actual ID
sed -i '' "s/\${WORKSPACE_ID}/$WORKSPACE_ID/g" workspace.yml

# Check for .env file
if [ ! -f .env ]; then
    echo "Creating .env file..."
    cat > .env << 'EOF'
# Atlas Environment Variables

# Anthropic Claude API Key
# Get from: https://console.anthropic.com/
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# OpenAI API Key (optional)
# Get from: https://platform.openai.com/api-keys
OPENAI_API_KEY=your_openai_api_key_here
EOF
    echo "⚠️  Please update .env with your Anthropic API key"
fi

# Update .gitignore
if [ -f .gitignore ]; then
    grep -q "^\.env$" .gitignore || echo ".env" >> .gitignore
    grep -q "^\.atlas/$" .gitignore || echo ".atlas/" >> .gitignore
    grep -q "^\*\.log$" .gitignore || echo "*.log" >> .gitignore
else
    cat > .gitignore << EOF
.env
.atlas/
*.log
EOF
fi

echo "✅ Workspace setup complete!"
echo "   Workspace ID: $WORKSPACE_ID"
echo "   Configuration: workspace.yml"
echo ""
echo "Next steps:"
echo "1. Update .env with your Anthropic API key"
echo "2. Run: deno task atlas workspace serve"
echo "3. In another terminal: deno task atlas signal trigger telephone-message --data '{\"message\": \"Hello world\"}'"