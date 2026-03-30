package service

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/httplog/v2"
	"github.com/slack-go/slack"
	"github.com/slack-go/slack/slackevents"
)

// SlackMessageEvent is the routing-relevant subset of a Slack message event.
type SlackMessageEvent struct {
	TeamID      string
	Channel     string
	ChannelType string // "dm", "channel", "group", "mpim", "app_home"
	User        string
	Text        string
	Timestamp   string // Slack message timestamp
	ThreadTS    string
}

// handlePerAppSlackWebhook handles webhooks for per-workspace Slack apps.
// Route: POST /webhook/slack/{userID}/{appID}
//
// Looks up the signing secret from the slack_app_webhook table (LRU-cached)
// using the app_id from the URL path. This works for all event types including
// url_verification (which lacks api_app_id in the JSON body).
func handlePerAppSlackWebhook(router *EventRouter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		log := httplog.LogEntry(r.Context())

		// Slack retries if we don't respond within 3s. Ack retries immediately
		// since we already accepted the original event.
		if r.Header.Get("X-Slack-Retry-Num") != "" {
			log.Debug("Acking Slack retry", "retryNum", r.Header.Get("X-Slack-Retry-Num"))
			w.WriteHeader(http.StatusOK)
			return
		}

		userID := chi.URLParam(r, "userID")
		appID := chi.URLParam(r, "appID")

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			log.Error("Failed to read webhook body", "error", err)
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		defer func() { _ = r.Body.Close() }()

		webhook, err := router.lookupWebhookSecret(r.Context(), appID)
		if err != nil {
			log.Error("Failed to get signing secret",
				"appID", appID,
				"error", err,
			)
			http.Error(w, "signing secret lookup failed", http.StatusUnauthorized)
			return
		}

		if webhook.userID != userID {
			log.Error("User ID mismatch",
				"appID", appID,
				"urlUserID", userID,
				"dbUserID", webhook.userID,
			)
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		sv, err := slack.NewSecretsVerifier(r.Header, webhook.signingSecret)
		if err != nil {
			log.Error("Signature verifier error", "error", err)
			http.Error(w, "signature verifier error", http.StatusUnauthorized)
			return
		}
		if _, err := sv.Write(body); err != nil {
			log.Error("Failed to write body to verifier", "error", err)
			http.Error(w, "signature verification failed", http.StatusUnauthorized)
			return
		}
		if err := sv.Ensure(); err != nil {
			log.Error("Signature verification failed",
				"appID", appID,
				"error", err,
			)
			http.Error(w, "invalid signature", http.StatusUnauthorized)
			return
		}

		eventsAPIEvent, err := slackevents.ParseEvent(body, slackevents.OptionNoVerifyToken())
		if err != nil {
			log.Error("Failed to parse Slack event", "error", err)
			http.Error(w, "failed to parse event", http.StatusBadRequest)
			return
		}

		if eventsAPIEvent.Type == slackevents.URLVerification {
			var challenge slackevents.ChallengeResponse
			if err := json.Unmarshal(body, &challenge); err != nil {
				log.Error("Failed to parse challenge", "error", err)
				http.Error(w, "failed to parse challenge", http.StatusBadRequest)
				return
			}
			log.Info("Handling URL verification challenge", "appID", appID)
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(challenge.Challenge))
			return
		}

		if eventsAPIEvent.Type == slackevents.CallbackEvent {
			w.WriteHeader(http.StatusOK)

			go processPerAppSlackEvent(
				router, log,
				eventsAPIEvent,
				userID, appID,
			)
			return
		}

		log.Warn("Unknown Slack event type", "type", eventsAPIEvent.Type)
		w.WriteHeader(http.StatusOK)
	}
}

// processPerAppSlackEvent runs async. The daemon resolves workspace_id from app_id.
func processPerAppSlackEvent(
	router *EventRouter,
	log *slog.Logger,
	eventsAPIEvent slackevents.EventsAPIEvent,
	userID, appID string,
) {
	ctx := router.ctx
	innerEvent := eventsAPIEvent.InnerEvent

	var event *SlackMessageEvent

	switch ev := innerEvent.Data.(type) {
	case *slackevents.MessageEvent:
		if ev.BotID != "" || ev.SubType != "" {
			return
		}
		event = &SlackMessageEvent{
			TeamID:      eventsAPIEvent.TeamID,
			Channel:     ev.Channel,
			ChannelType: ev.ChannelType,
			User:        ev.User,
			Text:        ev.Text,
			Timestamp:   ev.TimeStamp,
			ThreadTS:    ev.ThreadTimeStamp,
		}

	case *slackevents.AppMentionEvent:
		event = &SlackMessageEvent{
			TeamID:      eventsAPIEvent.TeamID,
			Channel:     ev.Channel,
			ChannelType: "channel",
			User:        ev.User,
			Text:        ev.Text,
			Timestamp:   ev.TimeStamp,
			ThreadTS:    ev.ThreadTimeStamp,
		}

	default:
		log.Debug("Ignoring Slack event", "type", innerEvent.Type)
		return
	}

	payload := AtlasSlackPayload{
		Text: event.Text,
		Slack: AtlasSlackEventData{
			AppID:       appID,
			ChannelID:   event.Channel,
			TeamID:      event.TeamID,
			ChannelType: event.ChannelType,
			UserID:      event.User,
			Timestamp:   event.Timestamp,
			ThreadTS:    event.ThreadTS,
		},
	}

	atlasURL, err := router.constructAtlasURL(userID)
	if err != nil {
		log.Error("Failed to construct Atlas URL",
			"error", err,
			"userID", userID,
		)
		return
	}

	log.Debug("Routing per-app Slack event",
		"appID", appID,
		"userID", userID,
		"channel", event.Channel,
	)

	signalURL, err := url.JoinPath(atlasURL, "/signals/slack")
	if err != nil {
		log.Error("Failed to construct signal URL",
			"error", err,
			"userID", userID,
		)
		return
	}

	if err := router.forwardToAtlas(ctx, signalURL, payload); err != nil {
		log.Error("Failed to forward per-app Slack event",
			"error", err,
			"appID", appID,
			"userID", userID,
		)
	}
}
