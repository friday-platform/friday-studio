package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/phuslu/lru"
	"github.com/tempestteam/atlas/apps/signal-gateway/repo"
)

const (
	httpMaxIdleConns        = 100
	httpMaxIdleConnsPerHost = 10
	httpIdleConnTimeout     = 90 * time.Second
	httpTLSHandshakeTimeout = 10 * time.Second
)

type AtlasSlackPayload struct {
	Text  string              `json:"text"`
	Slack AtlasSlackEventData `json:"_slack"`
}

type AtlasSlackEventData struct {
	AppID       string `json:"app_id,omitempty"`
	ChannelID   string `json:"channel_id"`
	TeamID      string `json:"team_id"`
	ChannelType string `json:"channel_type"`
	UserID      string `json:"user_id"`
	Timestamp   string `json:"timestamp"`
	ThreadTS    string `json:"thread_ts,omitempty"`
}

type webhookCacheEntry struct {
	signingSecret string
	userID        string
}

type EventRouter struct {
	queries          *repo.Queries
	webhookCache     *lru.TTLCache[string, webhookCacheEntry]
	cacheTTL         time.Duration
	httpClient       *http.Client
	atlasURLTemplate string          // e.g., "https://atlas-%s.atlas.svc.cluster.local" or "http://localhost:8080"
	ctx              context.Context // Service context for async operations
}

const routeCacheSize = 1024

func NewEventRouter(
	ctx context.Context,
	queries *repo.Queries,
	cacheTTL time.Duration,
	atlasTimeout time.Duration,
	atlasURLTemplate string,
) *EventRouter {
	transport := &http.Transport{
		MaxIdleConns:        httpMaxIdleConns,
		MaxIdleConnsPerHost: httpMaxIdleConnsPerHost,
		IdleConnTimeout:     httpIdleConnTimeout,
		TLSHandshakeTimeout: httpTLSHandshakeTimeout,
	}

	return &EventRouter{
		queries:      queries,
		webhookCache: lru.NewTTLCache[string, webhookCacheEntry](routeCacheSize),
		cacheTTL:     cacheTTL,
		httpClient: &http.Client{
			Timeout:   atlasTimeout,
			Transport: transport,
		},
		atlasURLTemplate: atlasURLTemplate,
		ctx:              ctx,
	}
}

// lookupWebhookSecret resolves signing secret + user_id (LRU-cached).
func (er *EventRouter) lookupWebhookSecret(ctx context.Context, appID string) (webhookCacheEntry, error) {
	if entry, ok := er.webhookCache.Get(appID); ok {
		return entry, nil
	}

	row, err := er.queries.GetWebhookSecret(ctx, appID)
	if err != nil {
		return webhookCacheEntry{}, err
	}

	entry := webhookCacheEntry{
		signingSecret: row.SigningSecret,
		userID:        row.UserID,
	}
	er.webhookCache.Set(appID, entry, er.cacheTTL)
	return entry, nil
}

func (er *EventRouter) forwardToAtlas(ctx context.Context, url string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := er.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to forward to Atlas: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("unexpected status from Atlas: %d, body: %s", resp.StatusCode, string(body))
	}

	return nil
}

// constructAtlasURL builds the Atlas URL from user ID, validating the scheme.
func (er *EventRouter) constructAtlasURL(userID string) (string, error) {
	result := er.atlasURLTemplate
	if strings.Contains(result, "%s") {
		result = fmt.Sprintf(result, userID)
	}
	u, err := url.Parse(result)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("invalid atlas URL %q: must be http or https", result)
	}
	return result, nil
}
