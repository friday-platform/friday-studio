package service

import (
	"context"
	"time"

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

const (
	dbContextKey        = "persona-db"
	litellmDBContextKey = "litellm-db"

	// keyAliasPrefix must match atlas-operator/pkg/litellm.KeyAliasForUser.
	keyAliasPrefix = "atlas-"
)

type Service struct {
	Logger      *httplog.Logger
	cfg         Config
	pool        *pgxpool.Pool
	litellmPool *pgxpool.Pool
	tlsConfig   *server.TLSConfig
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

	// LiteLLM database (optional)
	var litellmPool *pgxpool.Pool
	if cfg.LiteLLMPostgresConnection != "" {
		litellmPool, err = newLiteLLMPool(ctx, cfg.LiteLLMPostgresConnection)
		if err != nil {
			logger.Error("Failed to create LiteLLM database pool", "error", err)
			return nil, err
		}
	}

	return &Service{
		Logger:      logger,
		cfg:         cfg,
		pool:        pool,
		litellmPool: litellmPool,
		tlsConfig:   cfg.TLSConfig,
	}, nil
}

// newLiteLLMPool creates a read-only pool with conservative settings for the LiteLLM database.
func newLiteLLMPool(ctx context.Context, connString string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, err
	}

	config.MinConns = 2
	config.MaxConns = 5
	config.MaxConnLifetime = 15 * time.Minute
	config.MaxConnIdleTime = 5 * time.Minute

	return pgxpool.NewWithConfig(ctx, config)
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
		if s.litellmPool != nil {
			r.Use(pgxdb.WithPool(s.litellmPool, litellmDBContextKey))
		}
		r.Get("/me", handleMe)
		r.Patch("/me", handleUpdateMe)
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
	if s.litellmPool != nil {
		s.litellmPool.Close()
	}
	return nil
}
