package tunnel

import (
	"testing"
	"time"
)

func TestParseLineQuickURL(t *testing.T) {
	now := time.Now()
	line := "+--------------------------------------------------------------------------+"
	got := parseLine(line, now)
	if len(got) != 0 {
		t.Errorf("border line should yield no events, got %v", got)
	}

	line = "|  https://random-words-here.trycloudflare.com  |"
	got = parseLine(line, now)
	if len(got) != 1 || got[0].Kind != EventURL {
		t.Fatalf("expected one URL event, got %+v", got)
	}
	if got[0].URL != "https://random-words-here.trycloudflare.com" {
		t.Errorf("URL: %q", got[0].URL)
	}
}

func TestParseLineConnected(t *testing.T) {
	got := parseLine("INF Registered tunnel connection connIndex=0 protocol=quic", time.Now())
	if len(got) != 1 || got[0].Kind != EventConnected {
		t.Errorf("expected EventConnected, got %+v", got)
	}
}

func TestParseLineDisconnected(t *testing.T) {
	got := parseLine("WRN Lost connection ...", time.Now())
	if len(got) != 1 || got[0].Kind != EventDisconnected {
		t.Errorf("expected EventDisconnected, got %+v", got)
	}
}

func TestParseLineNoise(t *testing.T) {
	got := parseLine("INF Initiating graceful shutdown", time.Now())
	if len(got) != 0 {
		t.Errorf("noise line should yield no events, got %v", got)
	}
}
