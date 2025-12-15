package service

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"github.com/go-chi/httplog/v2"
	"github.com/slack-go/slack"
	"github.com/slack-go/slack/slackevents"
)

// SlackMessageEvent represents a Slack message event (simplified for routing).
type SlackMessageEvent struct {
	TeamID      string
	Channel     string
	ChannelType string // "dm", "channel", "group", "mpim", "app_home"
	User        string
	Text        string
	Timestamp   string // Slack message timestamp
	ThreadTS    string
}

// handleSlackWebhook returns a handler for Slack Events API webhooks.
// Must respond within 3 seconds per Slack requirements.
func handleSlackWebhook(router *EventRouter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		log := httplog.LogEntry(r.Context())

		body, err := io.ReadAll(r.Body)
		if err != nil {
			log.Error("Failed to read Slack webhook body", "error", err)
			http.Error(w, "Failed to read request body", http.StatusBadRequest)
			return
		}
		defer func() { _ = r.Body.Close() }()

		// Verify signature
		sv, err := slack.NewSecretsVerifier(r.Header, router.signingSecret)
		if err != nil {
			log.Error("Slack signature verifier error", "error", err)
			http.Error(w, "signature verifier error", http.StatusUnauthorized)
			return
		}

		// Write body to verifier
		if _, err := sv.Write(body); err != nil {
			log.Error("Failed to write body to verifier", "error", err)
			http.Error(w, "signature verification failed", http.StatusUnauthorized)
			return
		}

		// Ensure signature is valid
		if err := sv.Ensure(); err != nil {
			log.Error("Slack signature verification failed", "error", err)
			http.Error(w, "Invalid signature", http.StatusUnauthorized)
			return
		}

		// Parse event using slackevents library
		eventsAPIEvent, err := slackevents.ParseEvent(
			body,
			slackevents.OptionNoVerifyToken(),
		)
		if err != nil {
			log.Error("Failed to parse Slack event", "error", err)
			http.Error(w, "failed to parse event", http.StatusBadRequest)
			return
		}

		// Handle URL verification challenge
		if eventsAPIEvent.Type == slackevents.URLVerification {
			var challengeResponse *slackevents.ChallengeResponse
			if err := json.Unmarshal(body, &challengeResponse); err != nil {
				log.Error("Failed to parse challenge", "error", err)
				http.Error(w, "failed to parse challenge", http.StatusBadRequest)
				return
			}

			log.Info("Handling Slack URL verification challenge")
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(challengeResponse.Challenge))
			return
		}

		// Handle event callbacks
		if eventsAPIEvent.Type == slackevents.CallbackEvent {
			// Respond immediately with 200 OK (Slack requires response within 3 seconds)
			w.WriteHeader(http.StatusOK)

			// Process event asynchronously with service context (not request context)
			// Request context is cancelled after we return
			go processSlackEvent(router, log, eventsAPIEvent)
			return
		}

		// Unknown event type
		log.Warn("Received unknown Slack event type", "type", eventsAPIEvent.Type)
		w.WriteHeader(http.StatusOK)
	}
}

// processSlackEvent processes a Slack event asynchronously.
func processSlackEvent(
	router *EventRouter,
	log *slog.Logger,
	eventsAPIEvent slackevents.EventsAPIEvent,
) {
	ctx := router.ctx
	innerEvent := eventsAPIEvent.InnerEvent

	// Handle message events
	switch ev := innerEvent.Data.(type) {
	case *slackevents.MessageEvent:
		// Ignore bot messages and message subtypes (edits, deletes, etc.)
		if ev.BotID != "" {
			log.Debug("Ignoring bot message", "botID", ev.BotID)
			return
		}
		if ev.SubType != "" {
			log.Debug("Ignoring message subtype", "subtype", ev.SubType)
			return
		}

		event := &SlackMessageEvent{
			TeamID:      eventsAPIEvent.TeamID,
			Channel:     ev.Channel,
			ChannelType: ev.ChannelType,
			User:        ev.User,
			Text:        ev.Text,
			Timestamp:   ev.TimeStamp,
			ThreadTS:    ev.ThreadTimeStamp,
		}

		log.Debug("Routing Slack message event",
			"teamID", event.TeamID,
			"channel", event.Channel,
			"user", event.User,
			"timestamp", event.Timestamp,
		)

		if err := router.RouteSlackEvent(ctx, event); err != nil {
			log.Error("Failed to route Slack event",
				"error", err,
				"teamID", event.TeamID,
				"timestamp", event.Timestamp,
			)
		}

	case *slackevents.AppMentionEvent:
		// Handle app mentions
		event := &SlackMessageEvent{
			TeamID:      eventsAPIEvent.TeamID,
			Channel:     ev.Channel,
			ChannelType: "channel", // App mentions are always in channels, not DMs
			User:        ev.User,
			Text:        ev.Text,
			Timestamp:   ev.TimeStamp,
			ThreadTS:    ev.ThreadTimeStamp,
		}

		log.Debug("Routing Slack app mention event",
			"teamID", event.TeamID,
			"channel", event.Channel,
			"user", event.User,
			"timestamp", event.Timestamp,
		)

		if err := router.RouteSlackEvent(ctx, event); err != nil {
			log.Error("Failed to route Slack event",
				"error", err,
				"teamID", event.TeamID,
				"timestamp", event.Timestamp,
			)
		}

	default:
		log.Debug("Ignoring Slack event", "type", innerEvent.Type)
	}
}
