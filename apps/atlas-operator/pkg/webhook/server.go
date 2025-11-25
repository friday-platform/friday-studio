package webhook

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Reconciler interface for triggering reconciliation.
type Reconciler interface {
	Reconcile(ctx context.Context) error
}

// Server handles webhook requests for on-demand reconciliation.
type Server struct {
	reconciler Reconciler
	token      string
	logger     *slog.Logger
	server     *http.Server
}

// RefreshResponse represents the webhook response.
type RefreshResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
}

// NewServer creates a new webhook server.
func NewServer(reconciler Reconciler, token string, logger *slog.Logger) *Server {
	return &Server{
		reconciler: reconciler,
		token:      token,
		logger:     logger,
	}
}

// Start starts the webhook server on the specified port.
func (s *Server) Start(port int) error {
	mux := http.NewServeMux()

	// Webhook endpoint for triggering refresh
	mux.HandleFunc("/api/v1/refresh", s.handleRefresh)

	// Health check endpoint
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})

	s.server = &http.Server{
		Addr:         fmt.Sprintf(":%d", port),
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.logger.Info("Starting webhook server", "port", port)
	if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("webhook server failed: %w", err)
	}
	return nil
}

// Shutdown gracefully shuts down the webhook server.
func (s *Server) Shutdown(ctx context.Context) error {
	if s.server != nil {
		return s.server.Shutdown(ctx)
	}
	return nil
}

// handleRefresh processes webhook requests to trigger reconciliation.
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	// Only accept POST requests
	if r.Method != http.MethodPost {
		s.sendError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// Authenticate request if token is configured
	if s.token != "" {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			s.logger.Warn("Webhook request without authorization header", "remote_addr", r.RemoteAddr)
			s.sendError(w, http.StatusUnauthorized, "missing authorization header")
			return
		}

		// Check Bearer token
		expectedAuth := "Bearer " + s.token
		if authHeader != expectedAuth {
			s.logger.Warn("Webhook request with invalid token", "remote_addr", r.RemoteAddr)
			s.sendError(w, http.StatusUnauthorized, "invalid authorization token")
			return
		}
	}

	// Log the refresh request
	s.logger.Info("Webhook refresh triggered", "remote_addr", r.RemoteAddr)

	// Trigger reconciliation
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	if err := s.reconciler.Reconcile(ctx); err != nil {
		s.logger.Error("Webhook-triggered reconciliation failed", "error", err)
		s.sendError(w, http.StatusInternalServerError, fmt.Sprintf("reconciliation failed: %v", err))
		return
	}

	s.logger.Info("Webhook-triggered reconciliation completed successfully")
	s.sendSuccess(w, "reconciliation triggered successfully")
}

// sendSuccess sends a successful JSON response.
func (s *Server) sendSuccess(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := RefreshResponse{
		Status:  "success",
		Message: message,
	}
	_ = json.NewEncoder(w).Encode(resp)
}

// sendError sends an error JSON response.
func (s *Server) sendError(w http.ResponseWriter, statusCode int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	resp := RefreshResponse{
		Status:  "error",
		Message: message,
	}
	_ = json.NewEncoder(w).Encode(resp)
}

// AuthMiddleware returns a middleware that validates the Bearer token.
func AuthMiddleware(token string, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if token == "" {
				// No authentication required
				next.ServeHTTP(w, r)
				return
			}

			authHeader := r.Header.Get("Authorization")
			if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
				logger.Warn("Unauthorized webhook request", "remote_addr", r.RemoteAddr)
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte("unauthorized"))
				return
			}

			providedToken := strings.TrimPrefix(authHeader, "Bearer ")
			if providedToken != token {
				logger.Warn("Invalid webhook token", "remote_addr", r.RemoteAddr)
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte("unauthorized"))
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
