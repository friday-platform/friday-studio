package service

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/apps/cortex/repo"
	"github.com/tempestteam/atlas/pkg/x/middleware/jwt"
)

type Service struct {
	Logger    *httplog.Logger
	config    Config
	pool      *pgxpool.Pool  // kept for Close()
	storage   *StorageClient // kept for Close()
	uploadSem chan struct{}  // Semaphore to limit concurrent uploads
}

func New(cfg Config) (*Service, error) {
	ctx := context.Background()
	logger := Logger(cfg)

	// GCS storage
	storage, err := NewStorageClient(ctx, cfg.GCSBucket, cfg.ServiceAccountKey)
	if err != nil {
		logger.Error("Failed to create storage client", "error", err)
		return nil, err
	}

	// Database
	pool, err := repo.NewPool(ctx, cfg.PostgresConnection)
	if err != nil {
		logger.Error("Failed to create database pool", "error", err)
		return nil, err
	}

	// Create semaphore for limiting concurrent uploads
	uploadSem := make(chan struct{}, cfg.MaxConcurrentUploads)

	return &Service{
		Logger:    logger,
		config:    cfg,
		pool:      pool,
		storage:   storage,
		uploadSem: uploadSem,
	}, nil
}

func (s *Service) Router() http.Handler {
	// Load JWT public key
	publicKey, err := jwt.LoadRSAPublicKeyFromFile(s.config.JWTPublicKeyFile)
	if err != nil {
		s.Logger.Error("failed to load JWT public key", "error", err)
		panic(err)
	}

	r := chi.NewRouter()

	// Global middleware
	r.Use(httplog.RequestLogger(s.Logger, []string{"/health"}))

	// Health check (no auth)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// Protected routes
	r.Group(func(r chi.Router) {
		r.Use(jwt.AuthMiddleware(publicKey, s.Logger.Logger))
		r.Use(DBCtxMiddleware(s.pool))
		r.Use(StorageCtxMiddleware(s.storage))

		r.Post("/objects", s.HandleUpload)
		r.Get("/objects", s.HandleList)
		r.Get("/objects/{id}", s.HandleDownload)
		r.Put("/objects/{id}", s.HandleUpdate)
		r.Delete("/objects/{id}", s.HandleDelete)

		r.Post("/objects/{id}/metadata", s.HandleSetMetadata)
		r.Get("/objects/{id}/metadata", s.HandleGetMetadata)
		r.Put("/objects/{id}/metadata", s.HandleSetMetadata)
	})

	return r
}

func (s *Service) Close() error {
	if s.pool != nil {
		s.pool.Close()
	}
	if s.storage != nil {
		return s.storage.Close()
	}
	return nil
}
