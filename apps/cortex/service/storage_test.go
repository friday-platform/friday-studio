package service

import (
	"testing"

	"github.com/google/uuid"
)

func TestStoragePath(t *testing.T) {
	tests := []struct {
		name     string
		id       string
		expected string
	}{
		{
			name:     "standard uuid",
			id:       "550e8400-e29b-41d4-a716-446655440000",
			expected: "550e8400/e29b/550e8400-e29b-41d4-a716-446655440000",
		},
		{
			name:     "another uuid",
			id:       "123e4567-e89b-12d3-a456-426614174000",
			expected: "123e4567/e89b/123e4567-e89b-12d3-a456-426614174000",
		},
		{
			name:     "all zeros",
			id:       "00000000-0000-0000-0000-000000000000",
			expected: "00000000/0000/00000000-0000-0000-0000-000000000000",
		},
		{
			name:     "all ones (hex f)",
			id:       "ffffffff-ffff-ffff-ffff-ffffffffffff",
			expected: "ffffffff/ffff/ffffffff-ffff-ffff-ffff-ffffffffffff",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id := uuid.MustParse(tt.id)
			result := StoragePath(id)
			if result != tt.expected {
				t.Errorf("StoragePath(%s) = %q, want %q", tt.id, result, tt.expected)
			}
		})
	}
}

func TestStoragePathFormat(t *testing.T) {
	// Generate random UUID and verify path format
	id := uuid.New()
	path := StoragePath(id)
	idStr := id.String()

	// Path should be: first8chars/next4chars/fullUUID
	expectedPrefix := idStr[:8] + "/" + idStr[9:13] + "/"
	if path[:14] != expectedPrefix {
		t.Errorf("StoragePath prefix = %q, want %q", path[:14], expectedPrefix)
	}

	// Path should end with full UUID
	if path[14:] != idStr {
		t.Errorf("StoragePath suffix = %q, want %q", path[14:], idStr)
	}
}
