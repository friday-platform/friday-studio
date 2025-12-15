package service

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestConstructAtlasURL(t *testing.T) {
	tests := []struct {
		name             string
		userID           string
		atlasURLTemplate string
		expectedURL      string
	}{
		{
			name:             "production mode with user substitution",
			userID:           "user123",
			atlasURLTemplate: "https://atlas-%s.atlas.svc.cluster.local",
			expectedURL:      "https://atlas-user123.atlas.svc.cluster.local",
		},
		{
			name:             "localhost without substitution",
			userID:           "user123",
			atlasURLTemplate: "http://localhost:8080",
			expectedURL:      "http://localhost:8080",
		},
		{
			name:             "user ID with hyphens",
			userID:           "user-456-test",
			atlasURLTemplate: "https://atlas-%s.atlas.svc.cluster.local",
			expectedURL:      "https://atlas-user-456-test.atlas.svc.cluster.local",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			er := &EventRouter{
				atlasURLTemplate: tt.atlasURLTemplate,
			}
			url := er.constructAtlasURL(tt.userID)
			assert.Equal(t, tt.expectedURL, url)
		})
	}
}
