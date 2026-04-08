package service

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httplog/v2"
	"github.com/tempestteam/atlas/pkg/server"
)

type service struct {
	logger      *httplog.Logger
	cfg         Config
	mux         *chi.Mux
	tlsConfig   *server.TLSConfig
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

func (s *service) Init(_ context.Context) error {
	s.logger.Info("Initializing Signal Gateway service")

	atlasTimeout := time.Duration(s.cfg.AtlasTimeoutSeconds) * time.Second

	s.eventRouter = NewEventRouter(
		s.ctx,
		atlasTimeout,
		s.cfg.AtlasURLTemplate,
	)

	s.logger.Info("Signal Gateway service initialized successfully")

	return nil
}

func (s *service) routes(r *chi.Mux) *chi.Mux {
	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.logger, []string{"/healthz", "/livez"}))

	r.Get("/livez", handleLiveness)
	r.Get("/healthz", handleLiveness) // No DB — liveness is sufficient for readiness

	// Per-workspace Slack app webhook (near-stateless proxy to atlasd)
	r.Post("/webhook/slack/{userID}/{appID}", handlePerAppSlackWebhook(s.eventRouter))

	return r
}

func handleLiveness(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
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

	return nil
}
