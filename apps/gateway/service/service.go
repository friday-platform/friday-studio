package service

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/apps/gateway/repo"
	"github.com/tempestteam/atlas/pkg/server"
)

type Service struct {
	Logger     *httplog.Logger
	cfg        Config
	client     *http.Client
	db         *pgxpool.Pool // nil when unsubscribe is disabled
	queries    *repo.Queries // nil when unsubscribe is disabled
	emailCache *EmailCache   // nil when DB unavailable
}

type contextKey string

const userIDContextKey contextKey = "userID"

// userIDFromContext returns the authenticated user ID set by jwtAuthMiddleware.
func userIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(userIDContextKey).(string); ok {
		return v
	}
	return ""
}

// atlasClaims defines the JWT claims structure for Atlas tokens.
type atlasClaims struct {
	Email        string `json:"email,omitempty"`
	UserMetadata struct {
		TempestUserID string `json:"tempest_user_id"`
	} `json:"user_metadata"`
	jwt.RegisteredClaims
}

func New(cfg Config) *Service {
	logger := Logger(cfg)
	logger.Debug("Creating service")

	svc := &Service{
		cfg:    cfg,
		Logger: logger,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}

	if cfg.PostgresConnection != "" {
		pool, err := repo.NewPool(context.Background(), cfg.PostgresConnection)
		if err != nil {
			logger.Error("Failed to initialize DB pool", "error", err)
		} else {
			svc.db = pool
			svc.emailCache = NewEmailCache(pool, 16384)

			if cfg.UnsubscribeEnabled() {
				svc.queries = repo.New(pool)
				logger.Info("Unsubscribe support enabled")
			}
		}
	}

	return svc
}

// maxBytesMiddleware limits request body size to prevent DoS attacks.
func maxBytesMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// jwtAuthMiddleware validates JWT tokens from the Authorization header.
// Tokens must be signed with the provided RSA public key, have issuer "tempest-atlas",
// and audience "atlas". Panics if the public key is invalid.
func jwtAuthMiddleware(publicKeyPEM string) func(http.Handler) http.Handler {
	publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(publicKeyPEM))
	if err != nil {
		panic("invalid JWT_PUBLIC_KEY: " + err.Error())
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "missing authorization header", http.StatusUnauthorized)
				return
			}

			tokenString, found := strings.CutPrefix(authHeader, "Bearer ")
			if !found || tokenString == "" {
				http.Error(w, "invalid authorization format", http.StatusUnauthorized)
				return
			}

			var claims atlasClaims
			token, err := jwt.ParseWithClaims(tokenString, &claims, func(t *jwt.Token) (any, error) {
				if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
					return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
				}
				return publicKey, nil
			}, jwt.WithIssuer("tempest-atlas"), jwt.WithAudience("atlas"))
			if err != nil {
				log := httplog.LogEntry(r.Context())
				log.Warn("JWT verification failed", "error", err)
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}

			if !token.Valid {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}

			fields := map[string]any{
				"userID": claims.UserMetadata.TempestUserID,
			}
			if claims.Email != "" {
				fields["email"] = claims.Email
			}
			httplog.LogEntrySetFields(r.Context(), fields)

			ctx := context.WithValue(r.Context(), userIDContextKey, claims.UserMetadata.TempestUserID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func (s *Service) Router() *chi.Mux {
	r := chi.NewRouter()

	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.Logger, []string{"/healthz"}))
	r.Use(middleware.Heartbeat("/healthz"))

	// Public unsubscribe routes (no auth — clicked from email)
	if s.queries != nil {
		r.Post("/unsubscribe", s.HandleUnsubscribe)
		r.Get("/unsubscribe", s.HandleUnsubscribePage)
	}

	r.Route("/v1", func(r chi.Router) {
		r.Use(jwtAuthMiddleware(s.cfg.JWTPublicKey))

		// SendGrid endpoint - 30MB limit (SendGrid's attachment limit)
		r.With(maxBytesMiddleware(30*1024*1024)).Post("/sendgrid/send", s.HandleSendGridEmail)

		// Parallel API proxy - 10MB limit (reasonable for API requests)
		r.With(maxBytesMiddleware(10*1024*1024)).HandleFunc("/parallel/*", s.HandleParallelProxy)
	})

	return r
}

// Close cleans up resources (DB connections).
func (s *Service) Close() {
	if s.db != nil {
		s.db.Close()
	}
}

func (s *Service) Serve() (*server.Config, <-chan error) {
	s.Logger.Info("Starting service", "port", s.cfg.Port)
	srv := &server.Config{
		Handler:   s.Router(),
		Port:      s.cfg.Port,
		TLSConfig: s.cfg.TLSConfig,
	}

	errChan := make(chan error, 1)
	go func() {
		errChan <- srv.Listen(context.Background())
	}()

	return srv, errChan
}
