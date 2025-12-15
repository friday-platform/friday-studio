package service

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseSlackCallback(t *testing.T) {
	tests := []struct {
		name     string
		body     string
		wantErr  bool
		validate func(*testing.T, *SlackCallbackPayload)
	}{
		{
			name: "valid Slack callback with success",
			body: `{
				"text": "Response from Atlas",
				"status": "success",
				"channel_id": "C1234567890",
				"thread_ts": "1234567890.123456"
			}`,
			wantErr: false,
			validate: func(t *testing.T, payload *SlackCallbackPayload) {
				assert.Equal(t, "Response from Atlas", payload.Text)
				assert.Equal(t, "success", payload.Status)
				assert.Equal(t, "C1234567890", payload.ChannelID)
				assert.Equal(t, "1234567890.123456", payload.ThreadTS)
			},
		},
		{
			name: "Slack callback with error",
			body: `{
				"status": "failed",
				"error": "Agent timeout",
				"channel_id": "C1234567890"
			}`,
			wantErr: false,
			validate: func(t *testing.T, payload *SlackCallbackPayload) {
				assert.Equal(t, "failed", payload.Status)
				assert.Equal(t, "Agent timeout", payload.Error)
				assert.Equal(t, "C1234567890", payload.ChannelID)
			},
		},
		{
			name:    "invalid JSON",
			body:    `{invalid json`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var payload SlackCallbackPayload
			err := json.Unmarshal([]byte(tt.body), &payload)

			if tt.wantErr {
				assert.Error(t, err)
				return
			}

			require.NoError(t, err)
			if tt.validate != nil {
				tt.validate(t, &payload)
			}
		})
	}
}
