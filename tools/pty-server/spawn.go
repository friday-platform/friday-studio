package main

import (
	"context"
	"fmt"
	"os"

	gopty "github.com/aymanbagabas/go-pty"
)

// spawnShell creates a PTY, spawns the configured shell attached to it,
// resizes to the requested dimensions, and (on Windows) wraps the
// process in a Job Object so closing the WS kills the entire descendant
// tree. On Unix, jobObj is always nil.
func spawnShell(
	ctx context.Context,
	shell string,
	args []string,
	cwd string,
	cols, rows int,
) (gopty.Pty, *gopty.Cmd, *jobObject, error) {
	pt, err := gopty.New()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("pty.New: %w", err)
	}

	if err := pt.Resize(cols, rows); err != nil {
		_ = pt.Close()
		return nil, nil, nil, fmt.Errorf("resize: %w", err)
	}

	env := buildChildEnv()
	cmd := pt.CommandContext(ctx, shell, args...)
	cmd.Dir = cwd
	cmd.Env = env

	if err := cmd.Start(); err != nil {
		_ = pt.Close()
		return nil, nil, nil, fmt.Errorf("start: %w", err)
	}

	jobObj, err := attachJobObject(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = pt.Close()
		return nil, nil, nil, fmt.Errorf("job object: %w", err)
	}

	return pt, cmd, jobObj, nil
}

// buildChildEnv inherits the current process env plus the prompt/term
// overrides the TS server set (see server.ts:78-80).
func buildChildEnv() []string {
	env := os.Environ()
	overrides := map[string]string{
		"PS1":    "$ ",
		"PROMPT": "$ ",
		"ENV":    "",
		"TERM":   "xterm-256color",
	}
	out := make([]string, 0, len(env)+len(overrides))
	seen := make(map[string]bool, len(overrides))
	for _, kv := range env {
		for k := range overrides {
			if len(kv) > len(k) && kv[:len(k)] == k && kv[len(k)] == '=' {
				kv = k + "=" + overrides[k]
				seen[k] = true
				break
			}
		}
		out = append(out, kv)
	}
	for k, v := range overrides {
		if !seen[k] {
			out = append(out, k+"="+v)
		}
	}
	return out
}
