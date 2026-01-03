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
	"github.com/tempestteam/atlas/pkg/server"
)

type Service struct {
	Logger *httplog.Logger
	cfg    Config
	client *http.Client
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

	return &Service{
		cfg:    cfg,
		Logger: logger,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
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

			// Add user identity to log context
			httplog.LogEntrySetFields(r.Context(), map[string]any{
				"userID": claims.UserMetadata.TempestUserID,
				"email":  claims.Email,
			})

			next.ServeHTTP(w, r)
		})
	}
}

func (s *Service) Router() *chi.Mux {
	r := chi.NewRouter()

	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.Logger, []string{"/healthz"}))
	r.Use(middleware.Heartbeat("/healthz"))

	r.Route("/v1", func(r chi.Router) {
		r.Use(jwtAuthMiddleware(s.cfg.JWTPublicKey))

		// SendGrid endpoint - 30MB limit (SendGrid's attachment limit)
		r.With(maxBytesMiddleware(30*1024*1024)).Post("/sendgrid/send", s.HandleSendGridEmail)

		// Parallel API proxy - 10MB limit (reasonable for API requests)
		r.With(maxBytesMiddleware(10*1024*1024)).HandleFunc("/parallel/*", s.HandleParallelProxy)
	})

	return r
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
