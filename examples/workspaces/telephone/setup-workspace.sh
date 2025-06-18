#!/bin/bash

# Setup workspace for telephone game

echo "Setting up Atlas workspace for Telephone Game..."

# Create workspace.yml
cat > workspace.yml << 'EOF'
workspace:
  name: "Telephone Game"
  id: "${WORKSPACE_ID}"
  description: "A game where messages transform through multiple agents"

signals:
  telephone-message:
    provider: "cli"
    description: "Trigger a telephone game with a message"
    schema:
      type: "object"
      properties:
        message:
          type: "string"
          description: "The message to transform"
      required: ["message"]

agents:
  mishearing-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Specializes in phonetic errors and mishearing"
    prompts:
      system: "You are an agent that mishears messages. Transform the input by introducing phonetic errors, similar-sounding word substitutions, and slight misunderstandings."

  embellishment-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Adds context and embellishes stories"
    prompts:
      system: "You are an agent that embellishes messages. Add colorful details, context, and creative elements to make the message more elaborate and interesting."

  reinterpretation-agent:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Dramatically transforms messages"
    prompts:
      system: "You are an agent that reinterprets messages. Transform the meaning dramatically while maintaining some connection to the original theme."

jobs:
  telephone:
    triggers:
      - signal: "telephone-message"
        condition: {"and": [{"var": "message"}, {">": [{"length": {"var": "message"}}, 0]}]}
    execution:
      strategy: "sequential"
      agents:
        - id: "mishearing-agent"
          input_source: "signal"
        - id: "embellishment-agent"
          input_source: "previous"
        - id: "reinterpretation-agent"
          input_source: "previous"
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