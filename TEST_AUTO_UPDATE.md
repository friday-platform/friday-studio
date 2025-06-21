# Testing Automatic Homebrew Tap Updates

This file is created to test the automatic update mechanisms for both edge and nightly channels.

## Test Plan

1. **Edge Channel Test**: This commit should trigger edge workflow and update Homebrew tap
2. **Nightly Channel Test**: Manual trigger of nightly workflow to test tap update

## Expected Results

- Edge formula should update to `edge-{new_git_sha}`
- Nightly formula should update when nightly workflow runs

Test initiated: 2025-06-21