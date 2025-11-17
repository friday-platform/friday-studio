// Bounce is a service that handles the signup flow for Tempest
// It is responsible for sending emails, verifying email addresses,
// and creating new users in the database.
package service

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/httplog/v2"
	"github.com/go-chi/jwtauth/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/tempestteam/atlas/pkg/server"
	"github.com/tempestteam/atlas/pkg/x/middleware/pgxdb"
	"github.com/tempestteam/atlas/pkg/x/middleware/secure"
	"golang.org/x/oauth2/google"
)

type Config struct {
	BounceServiceURL          string `env:"BOUNCE_SERVICE_URL" envDefault:"http://localhost:8083"`
	CookieDomain              string `env:"COOKIE_DOMAIN" envDefault:"localhost"`
	CookieName                string `env:"COOKIE_NAME" envDefault:"atlas_token"`
	EmailDomain               string `env:"EMAIL_DOMAIN" envDefault:"atlas.tempestdx.dev"`
	JWTPrivateKey             string `env:"JWT_PRIVATE_KEY_FILE,file,required"`
	JWTPublicKey              string `env:"JWT_PUBLIC_KEY_FILE,file,required"`
	LogLevel                  string `env:"LOG_LEVEL" envDefault:"debug"`
	OAuthGoogleCredentialJSON string `env:"OAUTH_GOOGLE_CREDENTIALS_FILE,file,required"`
	Port                      string `env:"PORT" envDefault:"8083"`
	PostgresConnection        string `env:"POSTGRES_CONNECTION" envDefault:"postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable&search_path=bounce"`
	RedirectURI               string `env:"REDIRECT_URI" envDefault:"http://localhost:8080"`
	SendgridAPIKey            string `env:"SENDGRID_API_KEY_FILE,file,required"`
	ServiceName               string `env:"SERVICE_NAME" envDefault:"bounce"`
	SignupHMACSecret          string `env:"SIGNUP_HMAC_SECRET,required"`
	SignupHostname            string `env:"SIGNUP_HOSTNAME" envDefault:"http://localhost:8083"`
	CORSAllowedOrigins        string `env:"CORS_ALLOWED_ORIGINS" envDefault:"http://localhost:8080"`

	TLSConfig *server.TLSConfig
}

type service struct {
	Logger    *httplog.Logger
	cfg       Config
	mux       *chi.Mux
	tlsConfig *server.TLSConfig
	signupDB  *pgxpool.Pool
}

func New(cfg Config) *service {
	logger := Logger(cfg)
	logger.Debug("Creating service", "config", cfg)

	return &service{
		cfg:       cfg,
		Logger:    logger,
		mux:       chi.NewRouter(),
		tlsConfig: cfg.TLSConfig,
	}
}

func (s *service) routes(r *chi.Mux) *chi.Mux {
	r.Use(ConfigCtxMiddleware(s.cfg))
	r.Use(middleware.RealIP)
	r.Use(httplog.RequestLogger(s.Logger))
	r.Use(middleware.Heartbeat("/healthz"))
	r.Use(secure.NoSniff)
	r.Use(secure.PermissionsPolicy)
	r.Use(secure.CrossOriginPolicies)

	// Parse the RSA keys
	privateKey, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(s.cfg.JWTPrivateKey))
	if err != nil {
		s.Logger.Error("Failed to parse private key", "error", err)
		return nil
	}

	publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(s.cfg.JWTPublicKey))
	if err != nil {
		s.Logger.Error("Failed to parse public key", "error", err)
		return nil
	}

	sessionJWTOpts := jwtauth.New("RS256", privateKey, publicKey)
	sessionVerifier := jwtauth.Verify(sessionJWTOpts, func(r *http.Request) string {
		cookie, err := r.Cookie(s.cfg.CookieName)
		if err != nil {
			s.Logger.Warn("sessionJWT: error getting cookie from request", "error", err, "path", r.URL.Path, "headers", fmt.Sprintf("%+v", r.Header))
			return ""
		}
		s.Logger.Debug("sessionJWT: cookie", "cookie", cookie.Value)
		return cookie.Value
	})

	r.Group(func(r chi.Router) {
		r.Use(sessionVerifier)
		r.Use(jwtauth.Authenticator(sessionJWTOpts))
		r.Get("/sessioncheck", sessionCheck)
	})

	gCfg, err := google.ConfigFromJSON([]byte(s.cfg.OAuthGoogleCredentialJSON))
	if err != nil {
		s.Logger.Error("Failed to create google oauth config", "error", err)
		panic(err)
	}

	oaGoogle := oauthProvider{
		Provider: "google",
		Config:   gCfg,
	}

	r.Group(func(r chi.Router) {
		r.Use(pgxdb.WithPool(s.signupDB, "signup"))

		r.Route("/signup", func(r chi.Router) {
			r.Get("/email/verify", verifyEmailSignup)
			r.Post("/email", newEmailSignup)
		})
		r.Route("/oauth", func(r chi.Router) {
			r.Get("/google/authorize", oaGoogle.authRedirect)
			r.Get("/google/callback", oaGoogle.authCallback)
		})
		r.Route("/magiclink", func(r chi.Router) {
			r.Post("/", sendMagicLink)
			r.Get("/verify", verifyMagicLink)
		})
		r.Route("/logout", func(r chi.Router) {
			r.Get("/", logout)
		})
	})

	return r
}

/*
Init is a method on the service struct that initializes the service by setting up the database connection pool.
We specifically separate this out so main can call initialization and we keep New as a constructor
free of side effects that result in a dependency such as a network call.
*/
func (s *service) Init() error {
	poolCfg, err := pgxpool.ParseConfig(s.cfg.PostgresConnection)
	if err != nil {
		s.Logger.Error("Failed to parse pgxpool config", "error", err)
		return err
	}

	poolCfg.MinConns = 5
	poolCfg.MaxConns = 10
	poolCfg.MaxConnLifetime = time.Minute * 15
	poolCfg.MaxConnIdleTime = time.Minute * 5

	s.signupDB, err = pgxpool.NewWithConfig(context.Background(), poolCfg)
	if err != nil {
		s.Logger.Error("Failed to connect to signup database", "error", err)
		return err
	}

	err = s.signupDB.Ping(context.Background())
	if err != nil {
		s.Logger.Error("Failed to ping signup database", "error", err)
		return err
	}

	return nil
}

func (s *service) Serve() error {
	s.Logger.Info("Starting service", "port", s.cfg.Port)
	srv := &server.Config{
		Handler:   s.routes(s.mux),
		Port:      s.cfg.Port,
		TLSConfig: s.tlsConfig,
	}

	if err := s.tlsConfig.SetupTLS(); err != nil {
		s.Logger.Error("error setting up server TLS", "error", err)
		return err
	}

	return srv.Listen(context.Background())
}
