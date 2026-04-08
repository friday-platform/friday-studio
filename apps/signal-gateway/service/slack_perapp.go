package service

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/httplog/v2"
)

// handlePerAppSlackWebhook is a near-stateless proxy for per-workspace Slack apps.
// Route: POST /webhook/slack/{userID}/{appID}
//
// It handles url_verification challenges locally, acks Slack retries immediately,
// and forwards everything else (raw body + Slack headers) to atlasd where the
// Chat SDK's SlackAdapter handles signature verification, event parsing, etc.
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

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			log.Error("Failed to read webhook body", "error", err)
			http.Error(w, "failed to read request body", http.StatusBadRequest)
			return
		}
		defer func() { _ = r.Body.Close() }()

		// Handle url_verification challenge locally — no need to forward to atlasd.
		var envelope struct {
			Type      string `json:"type"`
			Challenge string `json:"challenge"`
		}
		if json.Unmarshal(body, &envelope) == nil && envelope.Type == "url_verification" {
			log.Info("Handling URL verification challenge", "userID", userID)
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(envelope.Challenge))
			return
		}

		// Build atlasd URL for this user.
		atlasURL, err := router.constructAtlasURL(userID)
		if err != nil {
			log.Error("Failed to construct Atlas URL", "error", err, "userID", userID)
			http.Error(w, "routing error", http.StatusInternalServerError)
			return
		}

		signalURL, err := url.JoinPath(atlasURL, "/signals/slack")
		if err != nil {
			log.Error("Failed to construct signal URL", "error", err, "userID", userID)
			http.Error(w, "routing error", http.StatusInternalServerError)
			return
		}

		// Ack Slack immediately, forward async.
		w.WriteHeader(http.StatusOK)

		go func() {
			req, err := http.NewRequestWithContext(router.ctx, "POST", signalURL, bytes.NewReader(body))
			if err != nil {
				log.Error("Failed to create forward request", "error", err, "userID", userID)
				return
			}

			// Forward Slack headers so atlasd can verify the signature.
			req.Header.Set("Content-Type", r.Header.Get("Content-Type"))
			if v := r.Header.Get("X-Slack-Request-Timestamp"); v != "" {
				req.Header.Set("X-Slack-Request-Timestamp", v)
			}
			if v := r.Header.Get("X-Slack-Signature"); v != "" {
				req.Header.Set("X-Slack-Signature", v)
			}

			resp, err := router.httpClient.Do(req)
			if err != nil {
				log.Error("Failed to forward to atlasd", "error", err, "userID", userID)
				return
			}
			defer func() { _ = resp.Body.Close() }()

			if resp.StatusCode >= 400 {
				respBody, _ := io.ReadAll(resp.Body)
				log.Error("Unexpected status from atlasd",
					"status", resp.StatusCode,
					"body", string(respBody),
					"userID", userID,
				)
			}
		}()
	}
}
