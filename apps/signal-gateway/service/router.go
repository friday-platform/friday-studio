package service

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	httpMaxIdleConns        = 100
	httpMaxIdleConnsPerHost = 10
	httpIdleConnTimeout     = 90 * time.Second
	httpTLSHandshakeTimeout = 10 * time.Second
)

type EventRouter struct {
	httpClient       *http.Client
	atlasURLTemplate string // e.g., "https://atlas-%s.atlas.svc.cluster.local" or "http://localhost:8080"
	ctx              context.Context
}

func NewEventRouter(
	ctx context.Context,
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
		httpClient: &http.Client{
			Timeout:   atlasTimeout,
			Transport: transport,
		},
		atlasURLTemplate: atlasURLTemplate,
		ctx:              ctx,
	}
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
