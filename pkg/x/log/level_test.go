package xlog

import (
	"log/slog"
	"testing"
)

func TestLogLevelFromString(t *testing.T) {
	testCases := []struct {
		name     string
		input    string
		expected slog.Level
	}{
		{
			name:     "Debug Lowercase",
			input:    "debug",
			expected: slog.LevelDebug,
		},
		{
			name:     "Debug Uppercase",
			input:    "DEBUG",
			expected: slog.LevelDebug,
		},
		{
			name:     "Info Mixed Case",
			input:    "InFo",
			expected: slog.LevelInfo,
		},
		{
			name:     "Warn",
			input:    "WARN",
			expected: slog.LevelWarn,
		},
		{
			name:     "Warning Alias",
			input:    "WARNING",
			expected: slog.LevelWarn,
		},
		{
			name:     "Error Lowercase",
			input:    "error",
			expected: slog.LevelError,
		},
		{
			name:     "Unknown Level",
			input:    "UNKNOWN",
			expected: slog.LevelDebug, // Should default to Debug
		},
		{
			name:     "Empty String",
			input:    "",
			expected: slog.LevelDebug, // Should default to Debug
		},
		{
			name:     "Arbitrary String",
			input:    "some other level",
			expected: slog.LevelDebug, // Should default to Debug
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			actual := LogLevelFromString(tc.input)
			if actual != tc.expected {
				t.Errorf("LogLevelFromString(%q) = %v; want %v", tc.input, actual, tc.expected)
			}
		})
	}
}
