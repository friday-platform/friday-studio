package service

import (
	"io"
	"net/http"
	"strings"
)

var parallelBaseURL = "https://api.parallel.ai"

// Whitelist of headers safe to forward to Parallel API
// Blocks sensitive headers like Authorization, Cookie, etc.
var allowedProxyHeaders = map[string]bool{
	"content-type":     true,
	"content-length":   true,
	"content-encoding": true,
	"accept":           true,
	"accept-encoding":  true,
	"accept-language":  true,
	"user-agent":       true,
	"cache-control":    true,
}

func (s *Service) HandleParallelProxy(w http.ResponseWriter, r *http.Request) {
	targetPath := strings.TrimPrefix(r.URL.Path, "/v1/parallel")
	targetURL := parallelBaseURL + targetPath
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	proxyReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL, r.Body)
	if err != nil {
		s.Logger.Error("failed to create parallel proxy request", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Forward only whitelisted headers
	for name, values := range r.Header {
		nameLower := strings.ToLower(name)
		if allowedProxyHeaders[nameLower] {
			for _, value := range values {
				proxyReq.Header.Add(name, value)
			}
		} else if nameLower != "host" {
			// Log blocked headers for monitoring (excluding host which is expected)
			s.Logger.Debug("blocked non-whitelisted header", "header", name)
		}
	}

	// Inject API key server-side
	proxyReq.Header.Set("x-api-key", s.cfg.ParallelAPIKey)

	resp, err := s.client.Do(proxyReq)
	if err != nil {
		s.Logger.Error("parallel proxy request failed", "error", err)
		recordParallelRequest(http.StatusBadGateway)
		http.Error(w, "proxy request failed", http.StatusBadGateway)
		return
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			s.Logger.Error("failed to close parallel response body", "error", err)
		}
	}()

	recordParallelRequest(resp.StatusCode)

	for name, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}

	w.WriteHeader(resp.StatusCode)
	if _, err := io.Copy(w, resp.Body); err != nil {
		s.Logger.Error("failed to copy parallel response body", "error", err)
	}
}
