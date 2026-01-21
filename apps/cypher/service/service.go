// Cypher is a transit encryption service that provides per-user AEAD encryption
// using Google Tink with AES-256-GCM. Keys are encrypted with Google Cloud KMS
// and stored in PostgreSQL.
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
	"github.com/tempestteam/atlas/apps/cypher/kms"
	"github.com/tempestteam/atlas/apps/cypher/repo"
	"github.com/tempestteam/atlas/pkg/server"
)

type service struct {
	Logger    *httplog.Logger
	cfg       Config
	mux       *chi.Mux
	tlsConfig *server.TLSConfig
	db        *pgxpool.Pool
	queries   *repo.Queries
	kms       kms.KeyEncryptionService
	cache     *KeyCache
	tokenDeps *TokenDeps   // nil if token endpoint not configured
	k8sClient *http.Client // nil if not running in Kubernetes
}

// New creates a new cypher service instance.
func New(cfg Config) *service {
	logger := Logger(cfg)
	logger.Debug("Creating cypher service")

	return &service{
		cfg:       cfg,
		Logger:    logger,
		mux:       chi.NewRouter(),
		tlsConfig: cfg.TLSConfig,
	}
}

// routes configures the HTTP routes for the service.
func (s *service) routes(r *chi.Mux) *chi.Mux {
	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.Logger, []string{"/healthz"}))
	r.Use(middleware.Heartbeat("/healthz"))
	r.Use(KeyCacheCtxMiddleware(s.cache))

	// Token endpoint - NOT protected by JWT (it issues JWTs)
	// K8s SA auth validates token; handler restricts to atlas namespace (atlas-sa-* SAs)
	if s.tokenDeps != nil {
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequestSize(1 << 20)) // 1MB
			r.Use(K8sServiceAccountAuthMiddleware(s.k8sClient, nil))
			r.Use(TokenDepsCtxMiddleware(s.tokenDeps))
			r.Post("/api/atlas-token", handleGeneratePodToken)
		})
	}

	// Internal endpoints - requires K8s service account token from atlas-operator
	// KeyCacheCtxMiddleware already applied globally above
	if s.k8sClient != nil {
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequestSize(1 << 20)) // 1MB
			r.Use(K8sServiceAccountAuthMiddleware(s.k8sClient, AllowedInternalServiceAccounts))
			r.Post("/internal/encrypt", handleInternalEncrypt)
		})
	}

	// Protected routes require JWT auth and have body size limits
	r.Group(func(r chi.Router) {
		r.Use(JWTAuthMiddleware(s.cfg.JWTPublicKey))
		r.Use(middleware.RequestSize(1 << 20)) // 1MB
		r.Post("/encrypt", handleEncrypt)
		r.Post("/decrypt", handleDecrypt)
		r.Get("/api/credentials", handleGetCredentials)
	})

	return r
}

/*
Init initializes the service by setting up the database connection pool and KMS.
We specifically separate this out so main can call initialization and we keep New
as a constructor free of side effects that result in a dependency such as a network call.
*/
func (s *service) Init() error {
	// Validate configuration
	if err := s.cfg.Validate(); err != nil {
		s.Logger.Error("Invalid configuration", "error", err)
		return err
	}

	// Initialize database connection pool
	poolCfg, err := pgxpool.ParseConfig(s.cfg.PostgresConnection)
	if err != nil {
		s.Logger.Error("Failed to parse pgxpool config", "error", err)
		return err
	}

	poolCfg.MinConns = 5
	poolCfg.MaxConns = 10
	poolCfg.MaxConnLifetime = time.Minute * 15
	poolCfg.MaxConnIdleTime = time.Minute * 5

	s.db, err = pgxpool.NewWithConfig(context.Background(), poolCfg)
	if err != nil {
		s.Logger.Error("Failed to connect to database", "error", err)
		return err
	}

	err = s.db.Ping(context.Background())
	if err != nil {
		s.Logger.Error("Failed to ping database", "error", err)
		return err
	}
	s.Logger.Info("Connected to database")

	// Initialize sqlc queries
	s.queries = repo.New(s.db)

	// Initialize KMS
	ctx := context.Background()
	switch s.cfg.KMSProvider {
	case "googlekms":
		s.kms, err = kms.NewGoogleKMS(ctx, s.cfg.GoogleKMSKeyURI)
		if err != nil {
			s.Logger.Error("Failed to initialize Google KMS", "error", err)
			return err
		}
		s.Logger.Info("Initialized Google KMS", "keyURI", s.cfg.GoogleKMSKeyURI)
	case "fake":
		s.kms = kms.NewFakeKMS()
		s.Logger.Warn("Using fake KMS - DO NOT USE IN PRODUCTION")
	}

	// Initialize key cache
	s.cache = NewKeyCache(s.db, s.kms, s.cfg.CacheSize)
	s.Logger.Info("Initialized key cache", "size", s.cfg.CacheSize)

	// Initialize Kubernetes HTTP client for internal endpoints
	k8sClient, err := InitK8sHTTPClient()
	if err != nil {
		s.Logger.Error("Failed to initialize Kubernetes HTTP client", "error", err)
		return fmt.Errorf("init Kubernetes HTTP client: %w", err)
	}

	if k8sClient == nil {
		s.Logger.Info("Internal endpoints disabled (not running in Kubernetes)")
	} else {
		// Enable internal encrypt endpoint (K8s SA token auth)
		s.k8sClient = k8sClient
		s.Logger.Info("Internal encrypt endpoint enabled")

		// Initialize token endpoint dependencies if configured
		if s.cfg.JWTPrivateKey != "" {
			privateKey, err := ParsePrivateKey(s.cfg.JWTPrivateKey)
			if err != nil {
				s.Logger.Error("Failed to parse JWT private key", "error", err)
				return fmt.Errorf("parse JWT private key: %w", err)
			}
			s.tokenDeps = &TokenDeps{
				JWTPrivateKey: privateKey,
				Pool:          s.db,
			}
			s.Logger.Info("Token endpoint enabled")
		}
	}

	return nil
}

// Serve starts the HTTP server and returns the server config and an error channel.
// TLS must be set up before calling Serve.
func (s *service) Serve() (*server.Config, <-chan error) {
	s.Logger.Info("Starting cypher service", "port", s.cfg.Port)
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

// Close cleans up service resources.
func (s *service) Close() error {
	if s.db != nil {
		s.db.Close()
		s.Logger.Info("Closed database connection pool")
	}
	return nil
}
