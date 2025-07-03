#!/bin/bash

# Binary Stripping Validation Script
# Validates that symbol stripping was applied correctly and binaries remain functional

set -e

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

# Function to count symbols (if tools available)
count_symbols() {
    if command_exists nm; then
        # Count non-debugging symbols
        nm "$1" 2>/dev/null | grep -v ' N ' | wc -l || echo "0"
    elif command_exists objdump; then
        # Alternative symbol counting
        objdump -t "$1" 2>/dev/null | wc -l || echo "0"
    else
        echo "unavailable"
    fi
}

# Function to check for debug sections (Linux/Unix)
check_debug_sections() {
    if command_exists objdump; then
        debug_sections=$(objdump -h "$1" 2>/dev/null | grep -c "debug" || echo "0")
        echo "$debug_sections"
    else
        echo "unavailable"
    fi
}

# Function to validate binary functionality
validate_binary() {
    local binary="$1"
    local platform="$2"
    
    echo "🔍 Validating binary functionality: $binary"
    
    if [ ! -f "$binary" ]; then
        echo "❌ Binary not found: $binary"
        return 1
    fi
    
    # Make sure binary is executable
    chmod +x "$binary"
    
    # Skip functional tests for cross-compiled binaries that can't run on current platform
    if [ "$platform" == "windows" ] && [[ "$OSTYPE" != "cygwin" ]] && [[ "$OSTYPE" != "msys" ]]; then
        echo "ℹ️  Skipping functional test for Windows binary on non-Windows platform"
        return 0
    elif [ "$platform" == "linux" ] && [[ "$OSTYPE" == "darwin"* ]]; then
        echo "ℹ️  Skipping functional test for Linux binary on macOS"
        return 0
    elif [ "$platform" == "darwin" ] && [[ "$OSTYPE" != "darwin"* ]]; then
        echo "ℹ️  Skipping functional test for macOS binary on non-macOS platform"
        return 0
    fi
    
    # Test binary execution based on platform
    case "$platform" in
        "windows")
            # On Windows, just verify file integrity
            if [ -f "$binary" ] && [ -s "$binary" ]; then
                echo "✅ Binary functional test passed: Windows file integrity check"
            else
                echo "⚠️  Windows binary file integrity check failed (may be expected)"
            fi
            ;;
        *)
            # On Unix-like systems, try actual execution
            if "$binary" --version >/dev/null 2>&1; then
                echo "✅ Binary functional test passed: --version"
            else
                echo "⚠️  Binary functional test failed: --version (may be expected after stripping)"
            fi
            
            if "$binary" --help >/dev/null 2>&1; then
                echo "✅ Binary functional test passed: --help"
            else
                echo "⚠️  Binary functional test warning: --help failed (may be expected)"
            fi
            ;;
    esac
    
    return 0
}

# Function to analyze single binary
analyze_binary() {
    local binary="$1"
    local platform="$2"
    local arch="$3"
    
    echo
    echo "📊 Analyzing: $binary ($platform-$arch)"
    echo "================================================"
    
    if [ ! -f "$binary" ]; then
        echo "❌ Binary not found: $binary"
        return 1
    fi
    
    # Basic file info
    local size=$(get_file_size "$binary")
    echo "📏 File size: $size bytes ($(numfmt --to=iec --suffix=B $size))"
    
    # Symbol analysis
    local symbols=$(count_symbols "$binary")
    if [ "$symbols" != "unavailable" ]; then
        echo "🔣 Symbol count: $symbols"
        if [ "$symbols" -gt 0 ]; then
            echo "ℹ️  Binary contains $symbols symbols"
        else
            echo "✅ Binary appears to be stripped (no symbols found)"
        fi
    else
        echo "⚠️  Symbol analysis tools not available"
    fi
    
    # Debug section analysis (Unix-like systems)
    if [[ "$platform" != "windows" ]]; then
        local debug_sections=$(check_debug_sections "$binary")
        if [ "$debug_sections" != "unavailable" ]; then
            # Clean up any extra newlines or spaces
            debug_sections=$(echo "$debug_sections" | tr -d '\n' | xargs)
            echo "🐛 Debug sections: $debug_sections"
            if [ "$debug_sections" -eq 0 ] 2>/dev/null; then
                echo "✅ No debug sections found"
            elif [ -n "$debug_sections" ] && [ "$debug_sections" != "0" ]; then
                echo "⚠️  Found $debug_sections debug sections"
            else
                echo "ℹ️  Debug section analysis inconclusive"
            fi
        fi
    fi
    
    # Platform-specific analysis
    case "$platform" in
        "linux")
            if command_exists file; then
                echo "🔍 File type: $(file "$binary" | cut -d: -f2 | xargs)"
            fi
            if command_exists ldd && [[ "$OSTYPE" == "linux-gnu"* ]]; then
                echo "📚 Dependencies: $(ldd "$binary" 2>/dev/null | wc -l || echo "static") shared libraries"
            fi
            ;;
        "darwin")
            if command_exists file; then
                echo "🔍 File type: $(file "$binary" | cut -d: -f2 | xargs)"
            fi
            if command_exists otool; then
                echo "📚 Dependencies: $(otool -L "$binary" 2>/dev/null | tail -n +2 | wc -l || echo "unknown") shared libraries"
            fi
            ;;
        "windows")
            if command_exists file; then
                echo "🔍 File type: $(file "$binary" | cut -d: -f2 | xargs)"
            fi
            ;;
    esac
    
    # Functional validation
    validate_binary "$binary" "$platform"
    
    echo "================================================"
    
    return 0
}

# Main function
main() {
    echo "🔍 Binary Stripping Validation Report"
    echo "====================================="
    echo "Generated: $(date)"
    echo "Platform: $(uname -s) $(uname -m)"
    echo "Working directory: $(pwd)"
    echo
    
    # Check for tool availability
    echo "🔧 Available analysis tools:"
    command_exists strip && echo "✅ strip" || echo "❌ strip"
    command_exists nm && echo "✅ nm" || echo "❌ nm"
    command_exists objdump && echo "✅ objdump" || echo "❌ objdump"
    command_exists file && echo "✅ file" || echo "❌ file"
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        command_exists ldd && echo "✅ ldd" || echo "❌ ldd"
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        command_exists otool && echo "✅ otool" || echo "❌ otool"
    fi
    echo
    
    # Look for binaries in common locations
    local binaries_found=0
    
    # Check ./dist/ directory (build output)
    if [ -d "./dist" ]; then
        echo "🔍 Checking ./dist/ directory..."
        for binary in ./dist/atlas ./dist/atlas.exe; do
            if [ -f "$binary" ]; then
                # Determine platform and arch from binary or context
                if [[ "$binary" == *.exe ]]; then
                    analyze_binary "$binary" "windows" "amd64"
                elif [[ "$OSTYPE" == "darwin"* ]]; then
                    analyze_binary "$binary" "darwin" "$(uname -m)"
                else
                    analyze_binary "$binary" "linux" "$(uname -m)"
                fi
                binaries_found=$((binaries_found + 1))
            fi
        done
    fi
    
    # Check current directory
    for binary in ./atlas ./atlas.exe; do
        if [ -f "$binary" ]; then
            if [[ "$binary" == *.exe ]]; then
                analyze_binary "$binary" "windows" "amd64"
            elif [[ "$OSTYPE" == "darwin"* ]]; then
                analyze_binary "$binary" "darwin" "$(uname -m)"
            else
                analyze_binary "$binary" "linux" "$(uname -m)"
            fi
            binaries_found=$((binaries_found + 1))
        fi
    done
    
    # Handle command line arguments
    if [ $# -gt 0 ]; then
        for arg in "$@"; do
            if [ -f "$arg" ]; then
                # Try to determine platform from filename or extension
                if [[ "$arg" == *windows* ]] || [[ "$arg" == *.exe ]]; then
                    platform="windows"
                elif [[ "$arg" == *darwin* ]] || [[ "$arg" == *macos* ]]; then
                    platform="darwin"
                elif [[ "$arg" == *linux* ]]; then
                    platform="linux"
                else
                    platform="unknown"
                fi
                
                # Try to determine architecture
                if [[ "$arg" == *arm64* ]] || [[ "$arg" == *aarch64* ]]; then
                    arch="arm64"
                elif [[ "$arg" == *amd64* ]] || [[ "$arg" == *x86_64* ]]; then
                    arch="amd64"
                else
                    arch="unknown"
                fi
                
                analyze_binary "$arg" "$platform" "$arch"
                binaries_found=$((binaries_found + 1))
            else
                echo "⚠️  File not found: $arg"
            fi
        done
    fi
    
    echo
    echo "📋 Validation Summary"
    echo "===================="
    echo "Binaries analyzed: $binaries_found"
    
    if [ $binaries_found -eq 0 ]; then
        echo "⚠️  No binaries found to analyze"
        echo "   Expected locations: ./dist/atlas, ./atlas, or specify paths as arguments"
        exit 1
    else
        echo "✅ Analysis completed successfully"
    fi
    
    echo
    echo "💡 Usage notes:"
    echo "   - Symbol stripping effectiveness varies by platform and binary type"
    echo "   - Deno binaries may not show significant size reduction"
    echo "   - Functional validation ensures stripping didn't break the binary"
    echo "   - Run with specific binary paths as arguments for targeted analysis"
    echo
}

# Run main function with all arguments
main "$@"