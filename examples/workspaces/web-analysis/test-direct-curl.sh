#!/bin/bash

echo "🧪 Testing direct curl to Atlas server..."
echo ""

# Test different endpoints to find the right one
echo "1. Testing health endpoint..."
curl -s http://localhost:8080/health | jq '.' 2>/dev/null || echo "Health endpoint failed or server not running"

echo ""
echo "2. Testing signals list endpoint..."
curl -s http://localhost:8080/signals | jq '.' 2>/dev/null || echo "Signals endpoint failed"

echo ""
echo "3. Testing signal trigger (webpage-analysis)..."
curl -s -X POST http://localhost:8080/signals/webpage-analysis \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "analysis_type": "detailed"}' \
  | jq '.' 2>/dev/null || echo "Signal trigger failed"

echo ""
echo "✅ Curl test completed"