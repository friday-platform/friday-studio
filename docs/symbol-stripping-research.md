# Symbol Stripping Research for Atlas Binary Build Process

## Overview
This document outlines the research for implementing symbol stripping across all target platforms in the Atlas GitHub Actions build process.

## Target Platforms & Runners
Based on the current build matrix:

1. **Linux amd64**: `x86_64-unknown-linux-gnu` (ubuntu-latest)
2. **Linux arm64**: `aarch64-unknown-linux-gnu` (ubuntu-latest, cross-compiled)
3. **macOS amd64**: `x86_64-apple-darwin` (macos-latest, cross-compiled)
4. **macOS arm64**: `aarch64-apple-darwin` (macos-15-xlarge, native)
5. **Windows amd64**: `x86_64-pc-windows-msvc` (windows-latest, cross-compiled)

## Symbol Stripping Tools & Commands by Platform

### Linux (ubuntu-latest)
**Tool**: `strip` (part of binutils)
- **Available by default**: Yes
- **Command**: `strip --strip-all <binary_path>`
- **Alternative**: `strip -s <binary_path>` (shorter form)
- **Flags**:
  - `--strip-all` / `-s`: Remove all symbols
  - `--strip-debug` / `-g`: Remove debug symbols only
  - `--strip-unneeded` / `-u`: Remove symbols not needed for relocations

**Cross-compilation considerations**:
- For ARM64 targets: Use `aarch64-linux-gnu-strip` if available
- Fallback to regular `strip` (should work for most cases)

### macOS (macos-latest, macos-15-xlarge)
**Tool**: `strip` (part of Xcode Command Line Tools)
- **Available by default**: Yes (with Xcode CLI tools)
- **Command**: `strip -S <binary_path>`
- **Flags**:
  - `-S`: Remove debug symbols
  - `-x`: Remove all local symbols
  - `-u`: Remove undefined symbols (use with caution)

**Cross-compilation considerations**:
- Native compilation on macos-15-xlarge (ARM64)
- Cross-compilation on macos-latest (x86_64 → ARM64)
- Same `strip` command works for both scenarios

### Windows (windows-latest)
**Tool**: Multiple options available
- **Option 1**: MinGW `strip` (if available)
  - Command: `strip --strip-all <binary_path>`
- **Option 2**: MSVC approach (no direct equivalent)
  - Deno's `--strip` flag during compilation
- **Option 3**: PowerShell with external tools

**Recommended approach**: Use Deno's built-in stripping flag during compilation

## Implementation Strategy

### Phase 1: Research Validation
1. **Test local availability**:
   ```bash
   # Linux/macOS
   which strip
   strip --version
   
   # Windows
   where strip
   strip --version
   ```

2. **Test with sample binaries**:
   - Create test binary with debug symbols
   - Apply stripping commands
   - Verify symbol removal and functionality

### Phase 2: Deno-Specific Considerations
**Key Finding**: Deno compile may have built-in stripping options
- Check for `--strip` or similar flags in Deno compile
- Investigate if Deno binaries contain standard debug symbols
- Test symbol presence in compiled Deno binaries

### Phase 3: Platform-Specific Implementation

#### Linux Implementation
```bash
# After deno compile
if [ "${{ inputs.platform }}" == "linux" ]; then
  echo "Stripping symbols from Linux binary..."
  strip --strip-all "./dist/${binary_name}"
fi
```

#### macOS Implementation
```bash
# After deno compile
if [ "${{ inputs.platform }}" == "darwin" ]; then
  echo "Stripping symbols from macOS binary..."
  strip -S "./dist/${binary_name}"
fi
```

#### Windows Implementation
```bash
# During deno compile - add --strip flag if available
# OR post-process if MinGW strip is available
if [ "${{ inputs.platform }}" == "windows" ]; then
  echo "Checking for Windows symbol stripping options..."
  if command -v strip &> /dev/null; then
    strip --strip-all "./dist/${binary_name}"
  else
    echo "Windows stripping not available, checking Deno options..."
  fi
fi
```

## Validation Strategy

### Symbol Presence Detection
```bash
# Linux: Check for symbols
nm <binary> | wc -l
objdump -t <binary> | wc -l

# macOS: Check for symbols
nm <binary> | wc -l
otool -I <binary>

# Windows: Check for symbols (if tools available)
objdump -t <binary> 2>/dev/null || echo "No objdump available"
```

### File Size Comparison
```bash
# Before stripping
stat -f%z <binary>  # macOS
stat -c%s <binary>  # Linux

# After stripping - compare sizes
```

### Functionality Verification
```bash
# Test binary still works
./<binary> --version
./<binary> --help
```

## Risk Assessment

### Low Risk
- **Linux**: Standard `strip` command, well-established process
- **macOS**: Built-in `strip` tool, widely used

### Medium Risk
- **Windows**: Limited native stripping options, may need alternative approaches
- **Cross-compilation**: Stripping cross-compiled binaries may require specific tools

### Mitigation Strategies
1. **Graceful fallback**: If stripping fails, continue with warning
2. **Validation**: Always test binary functionality after stripping
3. **Platform detection**: Use appropriate tools for each platform
4. **Error handling**: Proper error messages and continuation strategies

## Expected Outcomes

### File Size Reduction
- **Typical reduction**: 10-30% for debug symbols
- **Varies by**: Binary complexity, debug information amount
- **Deno specifics**: May be less dramatic due to Deno's compilation approach

### Performance Impact
- **Runtime**: No performance impact (positive or negative)
- **Load time**: Potentially faster due to smaller binary size
- **Memory usage**: Slightly reduced memory footprint

## Implementation Plan

### Step 1: Local Testing
- Test on available platforms (Linux, macOS)
- Create validation scripts
- Document actual results

### Step 2: GitHub Actions Integration
- Add stripping step to build-binary composite action
- Implement platform-specific logic
- Add validation steps

### Step 3: End-to-End Testing
- Test all 5 target platform combinations
- Verify functionality across all builds
- Measure file size reductions

### Step 4: Documentation
- Document the process
- Add troubleshooting guide
- Update build documentation

## Next Steps
1. **Immediate**: Test `strip` availability on GitHub Actions runners
2. **Phase 1**: Implement and test Linux/macOS stripping
3. **Phase 2**: Research and implement Windows approach
4. **Phase 3**: Add validation and error handling
5. **Phase 4**: Full end-to-end testing and documentation