package service

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/apps/signal-gateway/repo"
	"github.com/tempestteam/atlas/pkg/server"
)

// service represents the Signal Gateway service.
type service struct {
	logger      *httplog.Logger
	cfg         Config
	mux         *chi.Mux
	tlsConfig   *server.TLSConfig
	db          *pgxpool.Pool
	eventRouter *EventRouter
	ctx         context.Context
	cancel      context.CancelFunc
}

// New creates and returns a new Signal Gateway service instance.
func New(cfg Config) *service {
	logger := Logger(cfg)
	logger.Debug("Creating Signal Gateway service")

	ctx, cancel := context.WithCancel(context.Background())

	return &service{
		cfg:       cfg,
		logger:    logger,
		mux:       chi.NewRouter(),
		tlsConfig: cfg.TLSConfig,
		ctx:       ctx,
		cancel:    cancel,
	}
}

// GetLogger returns the service logger for external access (e.g., main.go).
func (s *service) GetLogger() *httplog.Logger {
	return s.logger
}

// Init initializes the service by setting up database and Slack connections.
func (s *service) Init(ctx context.Context) error {
	s.logger.Info("Initializing Signal Gateway service")

	// Validate configuration
	if err := s.cfg.Validate(); err != nil {
		s.logger.Error("Invalid configuration", "error", err)
		return err
	}

	// Initialize database
	if err := s.initDatabase(ctx); err != nil {
		return fmt.Errorf("failed to initialize database: %w", err)
	}

	// Initialize event router
	queries := repo.New(s.db)
	cacheTTL := time.Duration(s.cfg.RouteCacheTTLMinutes) * time.Minute
	atlasTimeout := time.Duration(s.cfg.AtlasTimeoutSeconds) * time.Second

	s.eventRouter = NewEventRouter(
		s.ctx,
		queries,
		cacheTTL,
		atlasTimeout,
		s.cfg.AtlasURLTemplate,
		s.cfg.SlackSigningSecret,
	)

	s.logger.Info("Signal Gateway service initialized successfully")

	return nil
}

// initDatabase initializes the database connection pool.
func (s *service) initDatabase(ctx context.Context) error {
	pool, err := repo.NewPool(ctx, s.cfg.PostgresConnection)
	if err != nil {
		return fmt.Errorf("failed to create database pool: %w", err)
	}

	// Test connection
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	s.db = pool
	s.logger.Info("Database connection established")

	return nil
}

// routes sets up all HTTP routes.
func (s *service) routes(r *chi.Mux) *chi.Mux {
	// Global middleware
	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.logger, []string{"/healthz", "/livez"}))

	// Health endpoints
	r.Get("/livez", handleLiveness)
	r.With(DBCtxMiddleware(s.db)).Get("/healthz", handleHealth)

	// Slack webhook endpoint
	r.Post("/webhook/slack", handleSlackWebhook(s.eventRouter))

	return r
}

// handleLiveness handles liveness probe requests by returning a simple 200 OK response.
// Liveness checks only verify the process is responsive, not dependency health.
func handleLiveness(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
}

// handleHealth handles readiness probe requests by verifying database connectivity.
// Readiness checks verify the service is ready to receive traffic.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	log := httplog.LogEntry(ctx)

	db, err := DBFromContext(ctx)
	if err != nil {
		log.Error("DB not in context", "error", err)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("internal error"))
		return
	}

	if err := db.Ping(ctx); err != nil {
		log.Error("Health check failed: database unhealthy", "error", err)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("database unhealthy"))
		return
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// Serve starts the HTTP server and returns the server config and an error channel.
// TLS must be set up before calling Serve.
func (s *service) Serve() (*server.Config, <-chan error) {
	s.logger.Info("Starting Signal Gateway HTTP server", "port", s.cfg.Port)

	srv := &server.Config{
		Handler:   s.routes(s.mux),
		Port:      s.cfg.Port,
		TLSConfig: s.tlsConfig,
	}

	errChan := make(chan error, 1)
	go func() {
		errChan <- srv.Listen(context.Background())
	}()

	return srv, errChan
}

// Close gracefully shuts down the service and cleans up resources.
func (s *service) Close() error {
	s.logger.Info("Closing Signal Gateway service")

	// Cancel service context to stop async operations
	if s.cancel != nil {
		s.cancel()
	}

	// Close database
	// Note: pgxpool.Close() doesn't take a context, it closes immediately
	if s.db != nil {
		s.db.Close()
		s.logger.Info("Database connection closed")
	}

	return nil
}
