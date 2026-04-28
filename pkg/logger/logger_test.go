package logger

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// decodeLine parses one JSON line of slog output and returns the
// resulting map.
func decodeLine(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("json decode %q: %v", raw, err)
	}
	return out
}

func TestComponentAlwaysPresent(t *testing.T) {
	t.Setenv("ATLAS_LOG_LEVEL", "debug")
	var buf bytes.Buffer
	log := NewWithWriter("test-bin", &buf)
	log.Info("hello")
	got := decodeLine(t, bytes.TrimSpace(buf.Bytes()))
	if got["component"] != "test-bin" {
		t.Errorf("expected component=test-bin, got %v", got["component"])
	}
	if got["msg"] != "hello" {
		t.Errorf("expected msg=hello, got %v", got["msg"])
	}
}

func TestKVPairs(t *testing.T) {
	t.Setenv("ATLAS_LOG_LEVEL", "info")
	var buf bytes.Buffer
	log := NewWithWriter("x", &buf)
	log.Info("event", "port", 9090, "alive", true)
	got := decodeLine(t, bytes.TrimSpace(buf.Bytes()))
	if got["port"].(float64) != 9090 {
		t.Errorf("port: want 9090, got %v", got["port"])
	}
	if got["alive"] != true {
		t.Errorf("alive: want true, got %v", got["alive"])
	}
}

func TestLevelFiltering(t *testing.T) {
	t.Setenv("ATLAS_LOG_LEVEL", "warn")
	var buf bytes.Buffer
	log := NewWithWriter("x", &buf)
	log.Debug("dropped")
	log.Info("dropped too")
	log.Warn("kept")
	log.Error("kept")
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 lines, got %d: %q", len(lines), lines)
	}
}

func TestChildMergesContext(t *testing.T) {
	t.Setenv("ATLAS_LOG_LEVEL", "info")
	var buf bytes.Buffer
	parent := NewWithWriter("x", &buf)
	child := parent.Child("provider", "github", "request_id", "abc")
	child.Info("rate limit hit", "retry_after_ms", 5000)
	got := decodeLine(t, bytes.TrimSpace(buf.Bytes()))
	if got["component"] != "x" {
		t.Errorf("component lost on child: %v", got["component"])
	}
	if got["provider"] != "github" {
		t.Errorf("provider missing: %v", got)
	}
	if got["request_id"] != "abc" {
		t.Errorf("request_id missing: %v", got)
	}
	if got["retry_after_ms"].(float64) != 5000 {
		t.Errorf("retry_after_ms: want 5000, got %v", got["retry_after_ms"])
	}
}

func TestLevelLabels(t *testing.T) {
	t.Setenv("ATLAS_LOG_LEVEL", "trace")
	var buf bytes.Buffer
	log := NewWithWriter("x", &buf)
	log.Trace("trace msg")
	log.Debug("debug msg")
	log.Info("info msg")
	log.Warn("warn msg")
	log.Error("error msg")
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	want := []string{"TRACE", "DEBUG", "INFO", "WARN", "ERROR"}
	if len(lines) != len(want) {
		t.Fatalf("want %d lines, got %d", len(want), len(lines))
	}
	for i, w := range want {
		got := decodeLine(t, []byte(lines[i]))
		if got["level"] != w {
			t.Errorf("line %d level: want %s, got %v", i, w, got["level"])
		}
	}
}

func TestUnknownLevelDefaultsInfo(t *testing.T) {
	t.Setenv("ATLAS_LOG_LEVEL", "blarg")
	var buf bytes.Buffer
	log := NewWithWriter("x", &buf)
	log.Debug("dropped")
	log.Info("kept")
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("want 1 line, got %d: %q", len(lines), lines)
	}
}

// TestFatalExits1 forks back into the binary in TestMain-helper mode
// to verify Fatal() actually calls os.Exit(1). Direct invocation can't
// be tested in-process because os.Exit terminates the test binary.
func TestFatalExits1(t *testing.T) {
	if os.Getenv("LOGGER_FATAL_HELPER") == "1" {
		log := New("x")
		log.Fatal("die")
		return // unreachable
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestFatalExits1")
	cmd.Env = append(os.Environ(), "LOGGER_FATAL_HELPER=1", "ATLAS_LOG_LEVEL=fatal")
	err := cmd.Run()
	if err == nil {
		t.Fatalf("expected exit 1, got nil")
	}
	exitErr := &exec.ExitError{}
	if errors.As(err, &exitErr) {
		if exitErr.ExitCode() != 1 {
			t.Errorf("expected exit code 1, got %d", exitErr.ExitCode())
		}
	} else {
		t.Errorf("expected *exec.ExitError, got %T: %v", err, err)
	}
}
