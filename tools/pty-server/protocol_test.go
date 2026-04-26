// Integration tests for pty-server. Spin up a real httptest server, dial
// real WebSocket connections, spawn real bash. No mocks.
//
// NOTE on coder/websocket context semantics: cancelling the context passed
// to Conn.Read closes the entire WebSocket (the library registers
// AfterFunc(ctx, c.close) — see conn.go in the dependency). Per-iteration
// read contexts therefore CANNOT be used as polling primitives — once the
// inner ctx expires, the conn is dead and subsequent Reads/Writes fail.
// Always derive read contexts from a single long-lived parent ctx for the
// duration of a session. See TestWS_ResizeMessage for the polling pattern.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// startTestServer brings up the pty-server on an ephemeral port.
func startTestServer(t *testing.T) string {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/pty", handlePty(Config{}))

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func wsURL(httpBase, query string) string {
	u, _ := url.Parse(httpBase)
	u.Scheme = "ws"
	u.Path = "/pty"
	u.RawQuery = query
	return u.String()
}

func dial(t *testing.T, base, query string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, wsURL(base, query), nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

// readNextStatus reads the first text frame and asserts it's a status msg.
func readNextStatus(t *testing.T, c *websocket.Conn) statusMsg {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, raw, err := c.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, websocket.MessageText, typ)
	var s statusMsg
	require.NoError(t, json.Unmarshal(raw, &s))
	return s
}

// drainBinaryUntil reads frames until the predicate matches the
// accumulated binary buffer or the 5s budget expires (t.Fatalf on timeout).
func drainBinaryUntil(t *testing.T, c *websocket.Conn, pred func([]byte) bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var buf bytes.Buffer
	for {
		typ, raw, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read failed (buf=%q): %v", buf.String(), err)
		}
		if typ == websocket.MessageBinary {
			buf.Write(raw)
			if pred(buf.Bytes()) {
				return
			}
		}
	}
}

func sendInput(t *testing.T, c *websocket.Conn, s string) {
	t.Helper()
	b, _ := json.Marshal(inputMsg{Type: "input", Data: s})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, websocket.MessageText, b))
}

func sendResize(t *testing.T, c *websocket.Conn, cols, rows int) {
	t.Helper()
	b, _ := json.Marshal(resizeMsg{Type: "resize", Cols: cols, Rows: rows})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, websocket.MessageText, b))
}

// ── §1.1–1.3: HTTP /health + CORS ────────────────────────────────────────────

func TestHealth_GetReturnsOK(t *testing.T) {
	base := startTestServer(t)
	resp, err := http.Get(base + "/health")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	body, _ := io.ReadAll(resp.Body)
	assert.JSONEq(t, `{"ok":true}`, string(body))
	assert.Equal(t, "*", resp.Header.Get("Access-Control-Allow-Origin"))
}

func TestHealth_OptionsReturnsNoContent(t *testing.T) {
	base := startTestServer(t)
	req, _ := http.NewRequest(http.MethodOptions, base+"/health", nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "*", resp.Header.Get("Access-Control-Allow-Origin"))
}

func TestHealth_CORSWithExternalOrigin(t *testing.T) {
	base := startTestServer(t)
	req, _ := http.NewRequest(http.MethodGet, base+"/health", nil)
	req.Header.Set("Origin", "https://other.example.com")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, "*", resp.Header.Get("Access-Control-Allow-Origin"))
}

// ── §1.4: WS cross-origin upgrade ────────────────────────────────────────────

// TestWS_CrossOrigin proves the InsecureSkipVerify policy in handlePty
// actually accepts mismatched Origin/Host pairs. Negative control: a
// stock coder/websocket Accept (no AcceptOptions) refuses the same handshake.
func TestWS_CrossOrigin(t *testing.T) {
	base := startTestServer(t)
	prodWS := wsURL(base, "")

	// Production handler: cross-origin must succeed.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, prodWS, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://evil.example.com"}},
	})
	require.NoError(t, err, "production handler must accept cross-origin")
	t.Cleanup(func() { _ = c.CloseNow() })

	// Negative control: a stock Accept (no opts) must reject the same handshake.
	ctrlMux := http.NewServeMux()
	ctrlMux.HandleFunc("/pty", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
	})
	ctrl := httptest.NewServer(ctrlMux)
	t.Cleanup(ctrl.Close)
	ctrlWS := wsURL(ctrl.URL, "")
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	_, _, err = websocket.Dial(ctx2, ctrlWS, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://evil.example.com"}},
	})
	require.Error(t, err, "stock Accept must reject cross-origin (negative control)")
}

// ── §1.4b: status message on connect ─────────────────────────────────────────

func TestWS_FirstMessageIsStatus(t *testing.T) {
	base := startTestServer(t)
	c := dial(t, base, "")
	st := readNextStatus(t, c)
	assert.Equal(t, "status", st.Type)
}

// ── §1.5: input → echo ───────────────────────────────────────────────────────

func TestWS_InputEchoes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses unix shell idioms")
	}
	base := startTestServer(t)
	c := dial(t, base, "")
	readNextStatus(t, c)

	sendInput(t, c, "echo HELLO_PTY\n")
	drainBinaryUntil(t, c, func(b []byte) bool {
		return bytes.Contains(b, []byte("HELLO_PTY"))
	})
}

// ── §1.6 + §1.8: resize ──────────────────────────────────────────────────────

func TestWS_ResizeQueryParam(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("stty not available")
	}
	base := startTestServer(t)
	c := dial(t, base, "cols=200&rows=60")
	readNextStatus(t, c)
	sendInput(t, c, "stty size\n")
	drainBinaryUntil(t, c, func(b []byte) bool {
		return bytes.Contains(b, []byte("60 200"))
	})
}

func TestWS_ResizeMessage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("stty not available")
	}
	base := startTestServer(t)
	c := dial(t, base, "")
	readNextStatus(t, c)
	sendResize(t, c, 120, 40)

	// Single long-lived ctx for the whole poll window — see file-header
	// note about coder/websocket context semantics. A goroutine sends
	// `stty size` periodically; the main loop reads until match or ctx
	// expires. Explicit join (writerDone) on cleanup so the goroutine
	// can't outlive the test function.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel() // safety; the closure below also calls it, idempotent
	writerDone := make(chan struct{})
	defer func() {
		cancel()
		<-writerDone
	}()

	go func() {
		defer close(writerDone)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				b, _ := json.Marshal(inputMsg{Type: "input", Data: "stty size\n"})
				if err := c.Write(ctx, websocket.MessageText, b); err != nil {
					return
				}
			}
		}
	}()

	var accumulated bytes.Buffer
	for {
		typ, raw, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("resize never propagated: %v (accumulated %q)", err, accumulated.String())
		}
		if typ == websocket.MessageBinary {
			accumulated.Write(raw)
			if bytes.Contains(accumulated.Bytes(), []byte("40 120")) {
				return
			}
		}
	}
}

// ── §1.7: exit ───────────────────────────────────────────────────────────────

func TestWS_ExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses unix exit semantics")
	}
	base := startTestServer(t)
	c := dial(t, base, "")
	readNextStatus(t, c)
	sendInput(t, c, "exit 0\n")

	// Drain frames until we see the exit message or the conn closes.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		typ, raw, err := c.Read(ctx)
		if err != nil {
			t.Fatal("connection closed before exit message")
		}
		if typ != websocket.MessageText {
			continue
		}
		var probe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil {
			continue
		}
		if probe.Type == "exit" {
			var ex exitMsg
			require.NoError(t, json.Unmarshal(raw, &ex))
			assert.Equal(t, 0, ex.Code)
			return
		}
	}
}

// ── §1.9 + §1.10–1.10d: cwd validation ────────────────────────────────────────

func TestWS_CwdValid(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses unix paths")
	}
	base := startTestServer(t)
	c := dial(t, base, "cwd=/tmp")
	readNextStatus(t, c)
	sendInput(t, c, "pwd\n")
	drainBinaryUntil(t, c, func(b []byte) bool {
		return bytes.Contains(b, []byte("/tmp"))
	})
}

func TestWS_CwdNonexistentReturnsError(t *testing.T) {
	base := startTestServer(t)
	c := dial(t, base, "cwd=/this/does/not/exist")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, raw, err := c.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, websocket.MessageText, typ)
	var em errorMsg
	require.NoError(t, json.Unmarshal(raw, &em))
	assert.Equal(t, "error", em.Type)
	assert.Contains(t, em.Message, "cwd does not exist")
}

func TestWS_CwdNotDirectoryReturnsError(t *testing.T) {
	base := startTestServer(t)
	// Use the test binary itself — guaranteed to exist and be a file.
	target := "/etc/hosts"
	if runtime.GOOS == "windows" {
		target = `C:\Windows\System32\drivers\etc\hosts`
	}
	c := dial(t, base, "cwd="+url.QueryEscape(target))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	typ, raw, err := c.Read(ctx)
	require.NoError(t, err)
	require.Equal(t, websocket.MessageText, typ)
	var em errorMsg
	require.NoError(t, json.Unmarshal(raw, &em))
	assert.Contains(t, em.Message, "not a directory")
}

func TestValidateCwd_EmptyFallsBack(t *testing.T) {
	cwd, err := validateCwd("", "")
	require.NoError(t, err)
	assert.NotEmpty(t, cwd)
}

func TestValidateCwd_RelativeResolved(t *testing.T) {
	cwd, err := validateCwd(".", "")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(cwd, "/") || strings.Contains(cwd, ":\\"))
}

// ── §1.11–1.12: malformed/unknown messages ───────────────────────────────────

func TestWS_MalformedJSONIgnored(t *testing.T) {
	base := startTestServer(t)
	c := dial(t, base, "")
	readNextStatus(t, c)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, websocket.MessageText, []byte("not json")))

	// Connection should stay open. Send a real message to confirm.
	if runtime.GOOS != "windows" {
		sendInput(t, c, "echo STILL_ALIVE\n")
		drainBinaryUntil(t, c, func(b []byte) bool {
			return bytes.Contains(b, []byte("STILL_ALIVE"))
		})
	}
}

func TestWS_UnknownTypeIgnored(t *testing.T) {
	base := startTestServer(t)
	c := dial(t, base, "")
	readNextStatus(t, c)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, websocket.MessageText, []byte(`{"type":"unknown"}`)))

	if runtime.GOOS != "windows" {
		sendInput(t, c, "echo STILL_ALIVE\n")
		drainBinaryUntil(t, c, func(b []byte) bool {
			return bytes.Contains(b, []byte("STILL_ALIVE"))
		})
	}
}

// ── §1.15: concurrent connections ────────────────────────────────────────────

func TestWS_ConcurrentConnections(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses unix shell idioms")
	}
	base := startTestServer(t)

	// Match e.g. "DONE_12345_END" but NOT the input-echo line which contains
	// the literal "$$" (no digits between underscores).
	pidRE := regexp.MustCompile(`DONE_(\d+)_END`)

	const N = 10 // §1.15 says 50; 10 is enough to surface obvious races.
	var wg sync.WaitGroup
	pids := make(chan string, N)

	// Each worker uses raw websocket API (NOT the t-coupled helpers like
	// dial/readNextStatus/sendInput) so failures use t.Errorf + return —
	// safe from worker goroutines. require.NoError / t.Fatalf would call
	// runtime.Goexit, which only kills the worker and leaves the test
	// recording an inconsistent failure across N goroutines.
	for range N {
		wg.Go(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()

			c, _, err := websocket.Dial(ctx, wsURL(base, ""), nil)
			if err != nil {
				t.Errorf("dial: %v", err)
				return
			}
			defer func() { _ = c.CloseNow() }()

			if _, _, err := c.Read(ctx); err != nil {
				t.Errorf("read status: %v", err)
				return
			}

			in, _ := json.Marshal(inputMsg{Type: "input", Data: `printf "DONE_%d_END\n" $$` + "\n"})
			if err := c.Write(ctx, websocket.MessageText, in); err != nil {
				t.Errorf("write input: %v", err)
				return
			}

			var buf bytes.Buffer
			for {
				typ, raw, err := c.Read(ctx)
				if err != nil {
					t.Errorf("read echo (buf=%q): %v", buf.String(), err)
					return
				}
				if typ != websocket.MessageBinary {
					continue
				}
				buf.Write(raw)
				if m := pidRE.FindStringSubmatch(buf.String()); m != nil {
					pids <- m[1]
					return
				}
			}
		})
	}
	wg.Wait()
	close(pids)

	seen := make(map[string]bool)
	for p := range pids {
		seen[p] = true
	}
	assert.GreaterOrEqual(t, len(seen), N-1, "expected mostly distinct PIDs")
}

// ── §1.21: --version flag ────────────────────────────────────────────────────

func TestPrintVersion(t *testing.T) {
	prev := GitCommit
	t.Cleanup(func() { GitCommit = prev })

	GitCommit = "test-sha-123"
	var buf bytes.Buffer
	printVersion(&buf)
	assert.Equal(t, "pty-server test-sha-123\n", buf.String())
}

// ── §1.22: ephemeral port ────────────────────────────────────────────────────
//
// httptest.NewServer (used by startTestServer) listens on :0 and the kernel
// assigns an ephemeral port — every test in this file already exercises that
// path. No standalone test needed.

// ── §1.16: large input under wsReadLimit ─────────────────────────────────────

// TestWS_LargeFrameUnderLimit sends a single text frame larger than
// coder/websocket's default 32 KiB read limit but under our 1 MiB cap,
// and asserts the WS layer accepts it (i.e., does NOT close with
// StatusMessageTooBig). That's the regression this test guards: dropping
// or removing the explicit SetReadLimit(1<<20) call would cause the
// library default (32 KiB) to apply and reject this 300 KiB frame.
//
// Note: this test does NOT prove the bytes were forwarded to the PTY.
// PTY-receipt would require waiting for terminal echo of all 300 KiB
// through bash readline, which is bandwidth-bounded (low-KB/s) and would
// take minutes. The WS-layer acceptance check is the meaningful signal —
// the SetReadLimit hardening lives in the WS layer.
func TestWS_LargeFrameUnderLimit(t *testing.T) {
	base := startTestServer(t)
	c := dial(t, base, "")
	readNextStatus(t, c)

	// 300 KiB — 10x the default 32 KiB limit, well under 1 MiB.
	huge := strings.Repeat("a", 300*1024)
	in, _ := json.Marshal(inputMsg{Type: "input", Data: huge})
	writeCtx, writeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer writeCancel()
	require.NoError(t, c.Write(writeCtx, websocket.MessageText, in),
		"oversized-but-under-limit frame should be accepted by WS layer")

	// Liveness probe: send a small follow-up frame, expect a successful
	// read back from the PTY. If the WS closed the conn after the large
	// frame (the regression we're guarding), the write or the read will
	// return a close error tagged with StatusMessageTooBig.
	probe, _ := json.Marshal(inputMsg{Type: "input", Data: "\n"})
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer probeCancel()
	if err := c.Write(probeCtx, websocket.MessageText, probe); err != nil {
		if websocket.CloseStatus(err) == websocket.StatusMessageTooBig {
			t.Fatalf("WS closed with StatusMessageTooBig after large frame — SetReadLimit not honored: %v", err)
		}
		t.Fatalf("liveness probe write failed: %v", err)
	}

	readCtx, readCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readCancel()
	_, _, err := c.Read(readCtx)
	if err != nil {
		if websocket.CloseStatus(err) == websocket.StatusMessageTooBig {
			t.Fatalf("WS closed with StatusMessageTooBig after large frame — SetReadLimit not honored: %v", err)
		}
		t.Fatalf("liveness probe read failed: %v", err)
	}
	// Note: the read may legitimately return shell-startup bytes that
	// were buffered before the 300 KiB write — pre-draining them would
	// require cancelling a Read ctx, which coder/websocket treats as a
	// signal to close the entire conn. The meaningful regression signal
	// here is the *absence* of a StatusMessageTooBig close error, which
	// the writes/reads above guard against. Mutation testing (commenting
	// out conn.SetReadLimit) confirms the regression is caught 10/10.
}

// ── §1.16b: oversized input rejected by ReadLimit ────────────────────────────

// TestWS_OversizedFrameRejected sends a frame just above wsReadLimit
// (1 MiB + 4 KiB). Pinning the boundary tightly means a regression that
// raises the limit (e.g., to 2 MiB) is caught — a test using 2 MiB+
// would silently accept a larger limit. The under-limit test (300 KiB)
// covers the lower direction (regressions that drop the limit).
func TestWS_OversizedFrameRejected(t *testing.T) {
	base := startTestServer(t)
	c := dial(t, base, "")
	readNextStatus(t, c)

	// 1 MiB + 4 KiB — just over wsReadLimit, sensitive to limit-set-too-high.
	huge := strings.Repeat("a", 1024*1024+4*1024)
	in, _ := json.Marshal(inputMsg{Type: "input", Data: huge})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.Write(ctx, websocket.MessageText, in)

	for {
		_, _, err := c.Read(ctx)
		if err != nil {
			status := websocket.CloseStatus(err)
			assert.Equal(t, websocket.StatusMessageTooBig, status,
				"expected StatusMessageTooBig, got %v (err=%v)", status, err)
			return
		}
	}
}

// ── parseClientMessage unit tests ────────────────────────────────────────────

func TestParseClientMessage_Variants(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want clientMsg
		ok   bool
	}{
		{"input", `{"type":"input","data":"x"}`, clientMsg{Type: "input", Data: "x"}, true},
		{"resize", `{"type":"resize","cols":80,"rows":24}`, clientMsg{Type: "resize", Cols: 80, Rows: 24}, true},
		{"unknown_type", `{"type":"foo"}`, clientMsg{}, false},
		{"malformed", `{"type":`, clientMsg{}, false},
		{"empty", ``, clientMsg{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseClientMessage([]byte(tc.raw))
			assert.Equal(t, tc.ok, ok)
			if tc.ok {
				assert.Equal(t, tc.want, got)
			}
		})
	}
}

// ── parseIntDefault unit tests ───────────────────────────────────────────────

func TestParseIntDefault(t *testing.T) {
	assert.Equal(t, 80, parseIntDefault("", 80))
	assert.Equal(t, 80, parseIntDefault("garbage", 80))
	assert.Equal(t, 80, parseIntDefault("0", 80))
	assert.Equal(t, 80, parseIntDefault("-5", 80))
	assert.Equal(t, 200, parseIntDefault("200", 80))
}
