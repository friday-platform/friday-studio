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

// GetLogger returns the logger for use by main.go.
func (s *service) GetLogger() *httplog.Logger {
	return s.logger
}

func (s *service) Init(ctx context.Context) error {
	s.logger.Info("Initializing Signal Gateway service")

	if err := s.initDatabase(ctx); err != nil {
		return fmt.Errorf("failed to initialize database: %w", err)
	}

	queries := repo.New(s.db)
	cacheTTL := time.Duration(s.cfg.RouteCacheTTLMinutes) * time.Minute
	atlasTimeout := time.Duration(s.cfg.AtlasTimeoutSeconds) * time.Second

	s.eventRouter = NewEventRouter(
		s.ctx,
		queries,
		cacheTTL,
		atlasTimeout,
		s.cfg.AtlasURLTemplate,
	)

	s.logger.Info("Signal Gateway service initialized successfully")

	return nil
}

func (s *service) initDatabase(ctx context.Context) error {
	pool, err := repo.NewPool(ctx, s.cfg.PostgresConnection)
	if err != nil {
		return fmt.Errorf("failed to create database pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	s.db = pool
	s.logger.Info("Database connection established")

	return nil
}

func (s *service) routes(r *chi.Mux) *chi.Mux {
	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.logger, []string{"/healthz", "/livez"}))

	r.Get("/livez", handleLiveness)
	r.With(DBCtxMiddleware(s.db)).Get("/healthz", handleHealth)

	// Per-workspace Slack app webhook (URL-based routing, DB-backed signing secrets)
	r.Post("/webhook/slack/{userID}/{appID}", handlePerAppSlackWebhook(s.eventRouter))

	return r
}

func handleLiveness(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
}

// handleHealth verifies database connectivity for readiness probes.
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

// Serve starts the HTTP server. TLS must be configured before calling.
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

func (s *service) Close() error {
	s.logger.Info("Closing Signal Gateway service")

	if s.cancel != nil {
		s.cancel()
	}

	// pgxpool.Close() doesn't take a context — closes immediately
	if s.db != nil {
		s.db.Close()
		s.logger.Info("Database connection closed")
	}

	return nil
}
