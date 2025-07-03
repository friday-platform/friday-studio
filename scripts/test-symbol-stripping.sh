#!/bin/bash

# Symbol Stripping Test Script for Atlas
# This script tests symbol stripping functionality locally before GitHub Actions implementation

set -e

echo "=== Atlas Symbol Stripping Test ==="
echo "Testing symbol stripping tools and validating binary functionality"
echo

# Create test directory
TEST_DIR="./test-symbol-stripping"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to get file size
get_file_size() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        stat -f%z "$1" 2>/dev/null || echo "0"
    else
        stat -c%s "$1" 2>/dev/null || echo "0"
    fi
}

# Function to count symbols
count_symbols() {
    if command_exists nm; then
        nm "$1" 2>/dev/null | wc -l || echo "0"
    else
        echo "nm not available"
    fi
}

# Function to test binary functionality
test_binary() {
    local binary="$1"
    local name="$2"
    
    echo "Testing $name binary functionality..."
    
    # Test version command
    if "$binary" --version >/dev/null 2>&1; then
        echo "✅ $name: --version works"
    else
        echo "❌ $name: --version failed"
        return 1
    fi
    
    # Test help command
    if "$binary" --help >/dev/null 2>&1; then
        echo "✅ $name: --help works"
    else
        echo "❌ $name: --help failed"
        return 1
    fi
    
    return 0
}

# Function to analyze binary
analyze_binary() {
    local binary="$1"
    local name="$2"
    
    if [ ! -f "$binary" ]; then
        echo "❌ Binary not found: $binary"
        return 1
    fi
    
    local size=$(get_file_size "$binary")
    local symbols=$(count_symbols "$binary")
    
    echo "📊 $name Analysis:"
    echo "   Size: $size bytes"
    echo "   Symbols: $symbols"
    
    # Store in variables for later comparison
    if [[ "$name" == "Original" ]]; then
        ORIGINAL_SIZE=$size
        ORIGINAL_SYMBOLS=$symbols
    elif [[ "$name" == "Stripped" ]]; then
        STRIPPED_SIZE=$size
        STRIPPED_SYMBOLS=$symbols
    fi
}

# Platform detection
detect_platform() {
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        echo "linux"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        echo "darwin"
    elif [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]]; then
        echo "windows"
    else
        echo "unknown"
    fi
}

# Main testing function
main() {
    echo "🔍 Environment Detection:"
    PLATFORM=$(detect_platform)
    echo "   Platform: $PLATFORM"
    echo "   OS Type: $OSTYPE"
    echo
    
    # Check for required tools
    echo "🔧 Tool Availability:"
    
    if command_exists deno; then
        echo "✅ Deno: $(deno --version | head -1)"
    else
        echo "❌ Deno: Not available"
        exit 1
    fi
    
    if command_exists strip; then
        echo "✅ strip: Available"
        strip --version 2>/dev/null || echo "   (version info not available)"
    else
        echo "❌ strip: Not available"
        STRIP_AVAILABLE=false
    fi
    
    if command_exists nm; then
        echo "✅ nm: Available"
    else
        echo "⚠️  nm: Not available (symbol counting limited)"
    fi
    
    if command_exists objdump; then
        echo "✅ objdump: Available"
    else
        echo "⚠️  objdump: Not available"
    fi
    
    echo
    
    # Build test binary
    echo "🏗️  Building test binary..."
    
    # Copy source files (go up one directory to access src)
    cp -r ../src . 2>/dev/null || echo "Source files not found, creating minimal test"
    
    # Create minimal test if source not available
    if [ ! -d "src" ]; then
        mkdir -p src
        cat > src/test.ts << 'EOF'
#!/usr/bin/env deno run --allow-all
console.log("Test binary v1.0.0");
if (Deno.args.includes("--version")) {
    console.log("test-binary 1.0.0");
    Deno.exit(0);
}
if (Deno.args.includes("--help")) {
    console.log("Usage: test-binary [--version] [--help]");
    Deno.exit(0);
}
EOF
        MAIN_FILE="src/test.ts"
    else
        MAIN_FILE="src/cli.tsx"
    fi
    
    # Build binary
    echo "   Building with deno compile..."
    
    if [[ "$PLATFORM" == "windows" ]]; then
        BINARY_NAME="test-atlas.exe"
    else
        BINARY_NAME="test-atlas"
    fi
    
    deno compile \
        --allow-all \
        --no-check \
        --output "$BINARY_NAME" \
        "$MAIN_FILE"
    
    if [ ! -f "$BINARY_NAME" ]; then
        echo "❌ Failed to build test binary"
        exit 1
    fi
    
    echo "✅ Test binary built: $BINARY_NAME"
    echo
    
    # Analyze original binary
    echo "📊 Original Binary Analysis:"
    analyze_binary "$BINARY_NAME" "Original"
    
    # Test original binary
    if ! test_binary "./$BINARY_NAME" "Original"; then
        echo "❌ Original binary test failed"
        exit 1
    fi
    echo
    
    # Create stripped version
    echo "✂️  Stripping symbols..."
    
    # Copy original for stripping
    STRIPPED_BINARY="stripped-$BINARY_NAME"
    cp "$BINARY_NAME" "$STRIPPED_BINARY"
    
    # Apply platform-specific stripping
    case "$PLATFORM" in
        "linux")
            echo "   Using Linux strip command..."
            if command_exists strip; then
                strip --strip-all "$STRIPPED_BINARY"
                echo "✅ Linux stripping completed"
            else
                echo "❌ strip command not available on Linux"
                exit 1
            fi
            ;;
        "darwin")
            echo "   Using macOS strip command..."
            if command_exists strip; then
                strip -S "$STRIPPED_BINARY"
                echo "✅ macOS stripping completed"
            else
                echo "❌ strip command not available on macOS"
                exit 1
            fi
            ;;
        "windows")
            echo "   Windows stripping options:"
            if command_exists strip; then
                strip --strip-all "$STRIPPED_BINARY"
                echo "✅ Windows stripping completed (using strip)"
            else
                echo "⚠️  strip command not available on Windows"
                echo "   Skipping stripping (would need alternative approach)"
                cp "$BINARY_NAME" "$STRIPPED_BINARY"
            fi
            ;;
        *)
            echo "❌ Unknown platform: $PLATFORM"
            exit 1
            ;;
    esac
    
    echo
    
    # Analyze stripped binary
    echo "📊 Stripped Binary Analysis:"
    analyze_binary "$STRIPPED_BINARY" "Stripped"
    
    # Test stripped binary
    if ! test_binary "./$STRIPPED_BINARY" "Stripped"; then
        echo "❌ Stripped binary test failed"
        exit 1
    fi
    echo
    
    # Compare results
    echo "📈 Comparison Results:"
    
    if [ "$ORIGINAL_SIZE" -gt 0 ] && [ "$STRIPPED_SIZE" -gt 0 ]; then
        SIZE_REDUCTION=$((ORIGINAL_SIZE - STRIPPED_SIZE))
        SIZE_REDUCTION_PERCENT=$((SIZE_REDUCTION * 100 / ORIGINAL_SIZE))
        
        echo "   Size reduction: $SIZE_REDUCTION bytes ($SIZE_REDUCTION_PERCENT%)"
        
        if [ "$SIZE_REDUCTION" -gt 0 ]; then
            echo "✅ Size reduction achieved"
        else
            echo "⚠️  No size reduction (may be expected for Deno binaries)"
        fi
    fi
    
    if [[ "$ORIGINAL_SYMBOLS" != "nm not available" ]] && [[ "$STRIPPED_SYMBOLS" != "nm not available" ]]; then
        echo "   Symbol reduction: $ORIGINAL_SYMBOLS → $STRIPPED_SYMBOLS"
        
        if [ "$STRIPPED_SYMBOLS" -lt "$ORIGINAL_SYMBOLS" ]; then
            echo "✅ Symbol reduction achieved"
        else
            echo "⚠️  No symbol reduction detected"
        fi
    fi
    
    echo
    echo "🎉 Symbol stripping test completed successfully!"
    echo
    echo "📋 Summary:"
    echo "   Platform: $PLATFORM"
    echo "   Strip tool: $(command_exists strip && echo "Available" || echo "Not available")"
    echo "   Original size: $ORIGINAL_SIZE bytes"
    echo "   Stripped size: $STRIPPED_SIZE bytes"
    echo "   Both binaries functional: ✅"
    echo
    echo "🧹 Cleanup:"
    echo "   Test files in: $TEST_DIR"
    echo "   Run 'rm -rf $TEST_DIR' to clean up"
}

# Run main function
main "$@"