package service

import (
	"context"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/go-chi/httplog/v2"
	"github.com/tempestteam/atlas/pkg/server"
)

type Service struct {
	Logger    *httplog.Logger
	cfg       Config
	mux       *chi.Mux
	tlsConfig *server.TLSConfig
	storage   *StorageClient
}

func New(cfg Config) *Service {
	logger := Logger(cfg)
	logger.Debug("Creating service")

	return &Service{
		cfg:       cfg,
		Logger:    logger,
		mux:       chi.NewRouter(),
		tlsConfig: cfg.TLSConfig,
	}
}

func (s *Service) Init(ctx context.Context) error {
	storage, err := NewStorageClient(ctx, s.cfg.GCSBucket, s.cfg.ServiceAccountKey)
	if err != nil {
		s.Logger.Error("Failed to create storage client", "error", err)
		return err
	}
	s.storage = storage
	return nil
}

func (s *Service) routes(r *chi.Mux) *chi.Mux {
	corsOptions := cors.Options{
		AllowedOrigins:   strings.Split(s.cfg.CORSAllowedOrigins, ","),
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Content-Type"},
		AllowCredentials: false,
		MaxAge:           600,
	}

	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.Logger, []string{"/healthz"}))
	r.Use(middleware.Heartbeat("/healthz"))
	r.Use(StorageClientCtxMiddleware(s.storage))
	r.Use(ShareBaseURLCtxMiddleware(s.cfg.ShareBaseURL))
	r.Use(cors.Handler(corsOptions))

	r.Get("/favicon.ico", faviconHandler)

	r.Route("/space", func(r chi.Router) {
		r.With(LimitRequestBody(s.cfg.MaxUploadSize)).Post("/", uploadHandler)
		r.Get("/{id}", serveHandler)
	})

	return r
}

func (s *Service) Serve() (*server.Config, <-chan error) {
	s.Logger.Info("Starting service", "port", s.cfg.Port)
	srv := &server.Config{
		Handler:   s.routes(s.mux),
		Port:      s.cfg.Port,
		TLSConfig: s.tlsConfig,
	}

	if err := s.tlsConfig.SetupTLS(); err != nil {
		s.Logger.Error("error setting up server TLS", "error", err)
		errChan := make(chan error, 1)
		errChan <- err
		return nil, errChan
	}

	errChan := make(chan error, 1)
	go func() {
		errChan <- srv.Listen(context.Background())
	}()

	return srv, errChan
}

func (s *Service) Close() error {
	if s.storage != nil {
		return s.storage.Close()
	}
	return nil
}
