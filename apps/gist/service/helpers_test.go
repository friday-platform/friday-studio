package service

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
)

func TestObjectPath(t *testing.T) {
	tests := []struct {
		name     string
		uuid     string
		expected string
	}{
		{
			name:     "standard uuid",
			uuid:     "9b378f95-23db-49aa-87d8-8e51dc79b2fc",
			expected: "9b378f95/23db/9b378f95-23db-49aa-87d8-8e51dc79b2fc",
		},
		{
			name:     "another uuid",
			uuid:     "123e4567-e89b-12d3-a456-426614174000",
			expected: "123e4567/e89b/123e4567-e89b-12d3-a456-426614174000",
		},
		{
			name:     "nil uuid",
			uuid:     "00000000-0000-0000-0000-000000000000",
			expected: "00000000/0000/00000000-0000-0000-0000-000000000000",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			id := uuid.MustParse(tt.uuid)
			result := ObjectPath(id)
			assert.Equal(t, tt.expected, result)
		})
	}
}
