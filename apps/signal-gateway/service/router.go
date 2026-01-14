package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/phuslu/lru"
	"github.com/tempestteam/atlas/apps/signal-gateway/repo"
)

const (
	// HTTP client connection pool configuration.
	httpMaxIdleConns        = 100
	httpMaxIdleConnsPerHost = 10
	httpIdleConnTimeout     = 90 * time.Second
	httpTLSHandshakeTimeout = 10 * time.Second
)

// AtlasSlackPayload represents the payload sent to Atlas for Slack events.
type AtlasSlackPayload struct {
	Text  string              `json:"text"`
	Slack AtlasSlackEventData `json:"_slack"`
}

// AtlasSlackEventData contains Slack-specific event metadata.
type AtlasSlackEventData struct {
	ChannelID   string `json:"channel_id"`
	TeamID      string `json:"team_id"`
	ChannelType string `json:"channel_type"`
	UserID      string `json:"user_id"`
	Timestamp   string `json:"timestamp"`
	ThreadTS    string `json:"thread_ts,omitempty"`
}

// EventRouter routes platform events to Atlas instances.
type EventRouter struct {
	queries          *repo.Queries
	cache            *lru.TTLCache[string, string]
	cacheTTL         time.Duration
	httpClient       *http.Client
	atlasURLTemplate string          // e.g., "https://atlas-%s.atlas.svc.cluster.local" or "http://localhost:8080"
	signingSecret    string          // Slack signing secret for webhook verification
	ctx              context.Context // Service context for async operations
}

// Cache size for route lookups (number of team_id -> user_id mappings).
const routeCacheSize = 1024

// NewEventRouter creates a new event router.
func NewEventRouter(
	ctx context.Context,
	queries *repo.Queries,
	cacheTTL time.Duration,
	atlasTimeout time.Duration,
	atlasURLTemplate string,
	signingSecret string,
) *EventRouter {
	// Configure HTTP transport with connection pooling
	transport := &http.Transport{
		MaxIdleConns:        httpMaxIdleConns,
		MaxIdleConnsPerHost: httpMaxIdleConnsPerHost,
		IdleConnTimeout:     httpIdleConnTimeout,
		TLSHandshakeTimeout: httpTLSHandshakeTimeout,
	}

	return &EventRouter{
		queries:  queries,
		cache:    lru.NewTTLCache[string, string](routeCacheSize),
		cacheTTL: cacheTTL,
		httpClient: &http.Client{
			Timeout:   atlasTimeout,
			Transport: transport,
		},
		atlasURLTemplate: atlasURLTemplate,
		signingSecret:    signingSecret,
		ctx:              ctx,
	}
}

// RouteSlackEvent routes a Slack message to the appropriate Atlas instance.
func (er *EventRouter) RouteSlackEvent(ctx context.Context, event *SlackMessageEvent) error {
	if event.TeamID == "" {
		return errors.New("team ID is required for Slack events")
	}

	// Look up route by Slack team ID
	userID, err := er.lookupSlackRoute(ctx, event.TeamID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("no route found for Slack team %s", event.TeamID)
		}
		return fmt.Errorf("failed to lookup route: %w", err)
	}

	// Construct URL and forward to Atlas
	atlasURL := er.constructAtlasURL(userID)

	payload := AtlasSlackPayload{
		Text: event.Text,
		Slack: AtlasSlackEventData{
			ChannelID:   event.Channel,
			TeamID:      event.TeamID,
			ChannelType: event.ChannelType,
			UserID:      event.User,
			Timestamp:   event.Timestamp,
			ThreadTS:    event.ThreadTS,
		},
	}

	return er.forwardToAtlas(ctx, atlasURL+"/signals/slack", payload)
}

// lookupSlackRoute looks up a Slack team route from cache first, then from database.
func (er *EventRouter) lookupSlackRoute(ctx context.Context, teamID string) (string, error) {
	// Check cache first
	if userID, ok := er.cache.Get(teamID); ok {
		return userID, nil
	}

	// Cache miss - query database
	userID, err := er.queries.GetUserIDByTeam(ctx, teamID)
	if err != nil {
		return "", err
	}

	// Cache the result
	er.cache.Set(teamID, userID, er.cacheTTL)
	return userID, nil
}

// forwardToAtlas forwards an event payload to an Atlas instance.
func (er *EventRouter) forwardToAtlas(ctx context.Context, url string, payload interface{}) error {
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

// constructAtlasURL constructs the Atlas instance URL from user ID.
func (er *EventRouter) constructAtlasURL(userID string) string {
	if strings.Contains(er.atlasURLTemplate, "%s") {
		return fmt.Sprintf(er.atlasURLTemplate, userID)
	}
	return er.atlasURLTemplate
}
