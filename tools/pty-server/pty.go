package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"sync/atomic"
	"time"

	gopty "github.com/aymanbagabas/go-pty"
	"github.com/coder/websocket"
)

const (
	pingInterval     = 30 * time.Second
	pingTimeout      = 5 * time.Second
	ptyCloseDeadline = 2 * time.Second
	wsReadLimit      = 1 << 20 // 1 MiB; default 32 KiB rejects large pastes.
	ptyReadBufSize   = 4096
)

// activeConns is bumped on accept and decremented on close. Used by the
// SIGTERM logger so operators can see how many sessions were torn down.
var activeConns atomic.Int64

func handlePty(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// Cheatsheet (port 5200) connects to pty-server (port 7681) via
			// Vite proxy, which is technically cross-origin. The TS server
			// did no Origin check; we mirror that. pty-server is localhost
			// in every deployment context (Docker exposes only via
			// per-pod network; Studio bundles it as an internal binary).
			InsecureSkipVerify: true,
		})
		if err != nil {
			//nolint:gosec // G706: structured logging via slog avoids injection.
			log.Error("ws accept failed", "remote", r.RemoteAddr, "error", err)
			return
		}
		conn.SetReadLimit(wsReadLimit)

		runSession(r, conn, cfg)
	}
}

func runSession(r *http.Request, conn *websocket.Conn, cfg Config) {
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	activeConns.Add(1)
	defer activeConns.Add(-1)

	// Resolve query params.
	q := r.URL.Query()
	cols := parseIntDefault(q.Get("cols"), 80)
	rows := parseIntDefault(q.Get("rows"), 24)

	cwd, err := validateCwd(q.Get("cwd"), cfg.Cwd)
	if err != nil {
		sendError(ctx, conn, err.Error())
		_ = conn.Close(websocket.StatusPolicyViolation, "invalid cwd")
		//nolint:gosec // G706: structured logging via slog avoids injection.
		log.Warn("cwd validation failed", "remote", r.RemoteAddr, "error", err)
		return
	}

	shell, args := defaultShell(cfg.Shell)

	pt, cmd, jobObj, err := spawnShell(ctx, shell, args, cwd, cols, rows)
	if err != nil {
		sendError(ctx, conn, fmt.Sprintf("spawn failed: %v", err))
		_ = conn.Close(websocket.StatusInternalError, "spawn failed")
		log.Error("pty spawn failed", "shell", shell, "error", err)
		return
	}

	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
	}
	connStart := time.Now()
	//nolint:gosec // G706: structured logging via slog avoids injection.
	log.Debug("ws conn accepted",
		"remote", r.RemoteAddr,
		"shell", shell,
		"cwd", cwd,
		"cols", cols,
		"rows", rows,
		"pid", pid,
	)

	// Send {type:"status",shell} immediately, matches TS server.
	if err := sendJSON(ctx, conn, statusMsg{Type: "status", Shell: shell}); err != nil {
		teardown(pt, cmd, jobObj, pid)
		_ = conn.CloseNow()
		return
	}

	// Goroutine: PTY → WS (binary).
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, ptyReadBufSize)
		for {
			n, err := pt.Read(buf)
			if n > 0 {
				if werr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// Goroutine: keepalive pings. coder/websocket handles the wire-level
	// ping/pong; the browser auto-pongs. We ride this for liveness.
	go func() {
		ticker := time.NewTicker(pingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				pCtx, pCancel := context.WithTimeout(ctx, pingTimeout)
				err := conn.Ping(pCtx)
				pCancel()
				if err != nil {
					// Filter benign disconnect signals: parent ctx
					// cancellation and the microsecond race where the
					// exit goroutine closes the conn before cancelling.
					benign := errors.Is(err, context.Canceled) || errors.Is(err, net.ErrClosed)
					if !benign {
						//nolint:gosec // G706: structured logging via slog avoids injection.
						log.Warn("ping failed", "remote", r.RemoteAddr, "pid", pid, "error", err)
					}
					cancel()
					return
				}
			}
		}
	}()

	// Goroutine: process exit. Once the shell dies, send {type:"exit"} and
	// close the WS.
	exitDone := make(chan struct{})
	go func() {
		defer close(exitDone)
		err := cmd.Wait()
		exitCode := 0
		if err != nil {
			var ee *exec.ExitError
			switch {
			case errors.As(err, &ee):
				exitCode = ee.ExitCode()
			default:
				exitCode = -1
			}
		}
		_ = sendJSON(ctx, conn, exitMsg{Type: "exit", Code: exitCode})
		_ = conn.Close(websocket.StatusNormalClosure, "exited")
		cancel()
	}()

	// Main loop: WS → PTY input/resize.
	for {
		typ, raw, err := conn.Read(ctx)
		if err != nil {
			break
		}
		if typ != websocket.MessageText {
			// Binary client→server is not part of the protocol; ignore.
			continue
		}
		msg, ok := parseClientMessage(raw)
		if !ok {
			//nolint:gosec // G706: structured logging via slog avoids injection.
			log.Warn("malformed message", "remote", r.RemoteAddr)
			continue
		}
		switch msg.Type {
		case "input":
			if _, werr := pt.Write([]byte(msg.Data)); werr != nil {
				cancel()
			}
		case "resize":
			if msg.Cols > 0 && msg.Rows > 0 {
				_ = pt.Resize(msg.Cols, msg.Rows)
			}
		}
	}

	cancel()
	teardown(pt, cmd, jobObj, pid)
	<-exitDone
	<-readDone

	//nolint:gosec // G706: structured logging via slog avoids injection.
	log.Debug("ws conn closed",
		"remote", r.RemoteAddr,
		"pid", pid,
		"duration_ms", time.Since(connStart).Milliseconds(),
	)
}

// teardown runs the bounded close sequence: cancel'd ctx → Pty.Close (2s
// budget) → Process.Kill → Job Object close (Windows). Without the bound,
// a stuck FD leaks the goroutine.
func teardown(pt gopty.Pty, cmd *gopty.Cmd, jobObj *jobObject, pid int) {
	closeDone := make(chan struct{})
	go func() {
		defer close(closeDone)
		_ = pt.Close()
	}()
	select {
	case <-closeDone:
	case <-time.After(ptyCloseDeadline):
		log.Warn("pty close timed out", "pid", pid)
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if jobObj != nil {
		_ = jobObj.Close()
	}
}

func sendJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}

func sendError(ctx context.Context, conn *websocket.Conn, message string) {
	_ = sendJSON(ctx, conn, errorMsg{Type: "error", Message: message})
}

func parseIntDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return def
	}
	return n
}
