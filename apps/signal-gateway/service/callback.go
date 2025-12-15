package service

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/go-chi/httplog/v2"
	"github.com/slack-go/slack"
)

// handleSlackCallback returns a handler for Slack callbacks from Atlas.
func handleSlackCallback(slackClient *slack.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		log := httplog.LogEntry(r.Context())

		body, err := io.ReadAll(r.Body)
		if err != nil {
			log.Error("Failed to read Slack callback body", "error", err)
			http.Error(w, "Failed to read request body", http.StatusBadRequest)
			return
		}
		defer func() { _ = r.Body.Close() }()

		var payload SlackCallbackPayload
		if err := json.Unmarshal(body, &payload); err != nil {
			log.Error("Failed to parse Slack callback payload", "error", err)
			http.Error(w, "Invalid payload", http.StatusBadRequest)
			return
		}

		if payload.ChannelID == "" {
			log.Error("Slack callback missing channel_id")
			http.Error(w, "Missing channel_id", http.StatusBadRequest)
			return
		}

		// Handle failed status
		if payload.Status == "failed" {
			log.Error("Atlas processing failed for Slack event",
				"error", payload.Error,
				"channelID", payload.ChannelID,
			)
			errorText := fmt.Sprintf("Failed to process message: %s", payload.Error)
			if err := sendSlackMessage(slackClient, payload.ChannelID, payload.ThreadTS, errorText); err != nil {
				log.Error("Failed to send Slack error message", "error", err)
				http.Error(w, "Failed to send message", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusOK)
			return
		}

		// Send success response
		if payload.Text == "" {
			w.WriteHeader(http.StatusOK)
			return
		}

		if err := sendSlackMessage(slackClient, payload.ChannelID, payload.ThreadTS, payload.Text); err != nil {
			log.Error("Failed to send Slack message", "error", err, "channelID", payload.ChannelID)
			http.Error(w, "Failed to send message", http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusOK)
	}
}

// sendSlackMessage sends a message to a Slack channel (optionally in a thread).
func sendSlackMessage(client *slack.Client, channelID, threadTS, text string) error {
	options := []slack.MsgOption{
		slack.MsgOptionText(text, false),
	}
	if threadTS != "" {
		options = append(options, slack.MsgOptionTS(threadTS))
	}
	_, _, err := client.PostMessage(channelID, options...)
	return err
}

// SlackCallbackPayload represents a callback from Atlas for Slack.
type SlackCallbackPayload struct {
	Text      string `json:"text"`
	Status    string `json:"status"` // "success" or "failed"
	Error     string `json:"error,omitempty"`
	ChannelID string `json:"channel_id"`
	ThreadTS  string `json:"thread_ts,omitempty"`
}
