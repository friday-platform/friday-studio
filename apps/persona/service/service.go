package service

import (
	"context"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httplog/v2"
	gojwt "github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tempestteam/atlas/apps/persona/repo"
	"github.com/tempestteam/atlas/pkg/server"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
	"github.com/tempestteam/atlas/pkg/x/middleware/pgxdb"
)

const dbContextKey = "persona-db"

type Service struct {
	Logger    *httplog.Logger
	cfg       Config
	pool      *pgxpool.Pool
	tlsConfig *server.TLSConfig
}

func New(cfg Config) (*Service, error) {
	ctx := context.Background()
	logger := Logger(cfg)

	// Database
	pool, err := repo.NewPool(ctx, cfg.PostgresConnection)
	if err != nil {
		logger.Error("Failed to create database pool", "error", err)
		return nil, err
	}

	return &Service{
		Logger:    logger,
		cfg:       cfg,
		pool:      pool,
		tlsConfig: cfg.TLSConfig,
	}, nil
}

func (s *Service) Router() *chi.Mux {
	// Load JWT public key (panic if invalid - fail fast at startup)
	publicKey, err := gojwt.ParseRSAPublicKeyFromPEM([]byte(s.cfg.JWTPublicKey))
	if err != nil {
		panic("invalid JWT_PUBLIC_KEY: " + err.Error())
	}

	r := chi.NewRouter()

	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.Logger, []string{"/healthz"}))
	r.Use(middleware.Heartbeat("/healthz"))
	r.Use(middleware.Recoverer)

	// Protected routes
	r.Route("/api", func(r chi.Router) {
		r.Use(jwt.AuthMiddleware(publicKey, s.Logger.Logger))
		r.Use(pgxdb.WithPool(s.pool, dbContextKey))
		r.Get("/me", handleMe)
	})

	return r
}

func (s *Service) Serve() (*server.Config, <-chan error) {
	s.Logger.Info("Starting service", "port", s.cfg.Port)
	srv := &server.Config{
		Handler:   s.Router(),
		Port:      s.cfg.Port,
		TLSConfig: s.tlsConfig,
	}

	errChan := make(chan error, 1)
	go func() {
		errChan <- srv.Listen(context.Background())
	}()

	return srv, errChan
}

func (s *Service) Close() error {
	if s.pool != nil {
		s.pool.Close()
	}
	return nil
}
