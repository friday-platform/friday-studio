#!/bin/sh
# Start a detached Deno process and return its PID

# Get all arguments
DENO_PATH="$1"
shift  # Remove first argument

# Get log file from environment variable if set
LOG_FILE="${ATLAS_LOG_FILE:-/dev/null}"

# Start the process in background, redirect output to log file
if [ "$LOG_FILE" != "/dev/null" ]; then
    "$DENO_PATH" "$@" >> "$LOG_FILE" 2>&1 &
else
    "$DENO_PATH" "$@" > /dev/null 2>&1 &
fi

# Get the PID
PID=$!

# Print the PID so parent can capture it
echo $PID

# Disown the process so it won't be killed when this script exits
disown $PID 2>/dev/null || true

# Exit immediately
exit 0