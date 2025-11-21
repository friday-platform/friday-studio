package service

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	pgx "github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	bouncerepo "github.com/tempestteam/atlas/apps/bounce/repo"
	pgxerr "github.com/tempestteam/atlas/pkg/x/pgxhelper"
	"golang.org/x/oauth2"
	"google.golang.org/api/googleapi"
	googleOAuth "google.golang.org/api/oauth2/v2"
	"google.golang.org/api/option"
)

type oauthProvider struct {
	Provider string
	Config   *oauth2.Config
}

type oauthRequest struct {
	RedirectTo string `in:"query=redirect_to" validate:"required,min=1"`
	Signup     bool   `in:"query=signup"`
}

type oauthStateClaims struct {
	jwt.RegisteredClaims
	Referrer        string   `json:"referrer"`
	Provider        string   `json:"provider"`
	ScopesRequested []string `json:"scopes"`
	RedirectTo      string   `json:"redirect_to"`
	Signup          bool     `json:"signup"`
}

func (c oauthStateClaims) SignedString(secret string) (string, error) {
	privateKey, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(secret))
	if err != nil {
		return "", fmt.Errorf("failed to parse RSA private key: %w", err)
	}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, c).SignedString(privateKey)
}

// NewOAuthStateClaimsFromJWT returns a new OAuthStateClaims from a JWT token.
func NewOAuthStateClaimsFromJWT(cfg Config, token string) (*oauthStateClaims, error) {
	claims := &oauthStateClaims{}
	_, err := jwt.ParseWithClaims(
		token,
		claims,
		func(token *jwt.Token) (interface{}, error) {
			publicKey, err := jwt.ParseRSAPublicKeyFromPEM([]byte(cfg.JWTPublicKey))
			if err != nil {
				return nil, fmt.Errorf("failed to parse RSA public key: %w", err)
			}
			return publicKey, nil
		},
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithIssuer(cfg.BounceServiceURL),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil {
		return nil, err
	}
	return claims, nil
}

// providerAuthRedirect returns a handler that redirects the user to the OAuth provider's authorization endpoint.
func (p oauthProvider) authRedirect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("Failed to get config from context", "error", err)
		http.Error(w, "Failed to get config from context", http.StatusInternalServerError)
		return
	}

	params, err := decodeAndValidateFromRequest[oauthRequest](ctx, w, r)
	if err != nil {
		return
	}

	// @TODO: store and validate this on the other end
	requestID := uuid.New().String()

	claims := oauthStateClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    cfg.BounceServiceURL,
			Subject:   requestID,
			Audience:  jwt.ClaimStrings{cfg.BounceServiceURL},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(5 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Referrer:        r.Header.Get("Referer"),
		Provider:        p.Provider,
		ScopesRequested: p.Config.Scopes,
		RedirectTo:      params.RedirectTo,
		Signup:          params.Signup,
	}

	stateToken, err := claims.SignedString(cfg.JWTPrivateKey)
	if err != nil {
		log.Error("Failed to sign state claims", "error", err)
		log.Debug("State claims", "claims", claims)
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}

	log.Debug("oauth authorize", "provider", p.Provider, "state", stateToken)

	p.Config.Scopes = append(p.Config.Scopes, "openid", "email", "profile")
	// generate sha256 challenge for PKCE flow
	uri := p.Config.AuthCodeURL(
		stateToken,
		oauth2.AccessTypeOffline,
		oauth2.ApprovalForce,
	)

	log.Debug("Redirecting to", "uri", uri)
	http.Redirect(w, r, uri, http.StatusFound)
}

type oAuthCallbackReq struct {
	Code  string `in:"query=code" validate:"required"`
	State string `in:"query=state" validate:"required"`
}

// authCallback handles the OAuth provider's callback.
// Handles login and signup flows.
func (p oauthProvider) authCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	params, err := decodeAndValidateFromRequest[oAuthCallbackReq](ctx, w, r)
	if err != nil {
		log.Debug("failed to decode and validate request, decodeAndValidate writes an HTTP response for us", "error", err)
		return
	}

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("Failed to get config from context", "error", err)
		http.Error(w, "Failed to get config from context", http.StatusInternalServerError)
		return
	}
	// If we got here, then that meets that the OAuth provider has successfully authenticated the user
	// and we have a valid access token. We can now use this access token to get the user's profile
	// information from the OAuth provider.

	// We validate the `state` query parameter first and check the data we stored in the state token
	claims, err := NewOAuthStateClaimsFromJWT(cfg, params.State)
	if err != nil {
		log.Error("Failed to decode state token", "error", err)
		http.Error(w, "Failed to decode state token", http.StatusBadRequest)
		return
	}

	if claims.Provider != p.Provider {
		// We should never get here except via misconfiguration/bug
		log.Error("Invalid provider", "provider", claims.Provider)
		http.Error(w, "Invalid provider", http.StatusBadRequest)
		return
	}

	// @TODO: specifically validate the Subject claim here as it has the request ID

	// We exchange the code for an access token
	token, err := p.Config.Exchange(ctx, params.Code, oauth2.AccessTypeOffline)
	if err != nil {
		log.Error("Failed to exchange code for token", "error", err)
		http.Error(w, "Failed to exchange code for token", http.StatusInternalServerError)
		return
	}

	tokenSource := p.Config.TokenSource(ctx, token)
	service, err := googleOAuth.NewService(ctx, option.WithTokenSource(tokenSource))
	if err != nil {
		log.Error("Failed to create google oauth service", "error", err)
		http.Error(w, "Failed to create google oauth service", http.StatusInternalServerError)
		return
	}
	userinfo := googleOAuth.NewUserinfoV2MeService(service)

	userInfoRequest := userinfo.Get()
	userInfoRequest.Header().Set("Cache-Control", "no-cache")
	userInfoRequest.Header().Set("Pragma", "no-cache")
	userInfoRequest.Header().Set("If-None-Match", "no-cache")
	userInfoRequest.Header().Set("If-Modified-Since", "no-cache")
	user, err := userInfoRequest.Do()
	if user.HTTPStatusCode != http.StatusOK || user == nil {
		log.Error("Failed to get user info", "error", err)
		http.Error(w, "Failed to get user info", http.StatusInternalServerError)
		return
	} else if googleapi.IsNotModified(err) {
		log.Error("User info not modified, we should never get here as we set `no-cache`", "error", err)
		http.Error(w, "User info not modified", http.StatusInternalServerError)
		return
	}

	if user.VerifiedEmail == nil || (user.VerifiedEmail != nil && !*user.VerifiedEmail) {
		log.Error("User email not verified in provider", "email", user.Email)
		http.Error(w, "User email not verified", http.StatusForbidden)
		return
	}

	providerUserID := user.Id

	expect := pgxerr.NewExpectation(
		pgxerr.WithLog(log),
		pgxerr.WithContext(ctx),
	)

	tx, queries, conn, err := queriesWithTx(ctx)
	defer expect.DeferRollbackRelease(tx, conn)
	if err != nil {
		log.Error("Failed to get transaction", "error", err)
		http.Error(w, "Failed to get transaction", http.StatusInternalServerError)
		return
	}

	// Track if this is a new user to Tempest based on auth data
	var (
		newUser     bool
		newIdentity bool
		authUser    *bouncerepo.BounceAuthUser
		tempestUser *bouncerepo.User
	)

	idx, err := queries.AuthIdentityByProviderEmail(ctx, &bouncerepo.AuthIdentityByProviderEmailParams{
		Provider: bouncerepo.BounceIdentityProvider(p.Provider),
		Email:    user.Email,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
			// This means there is no identity for this email/provider. This may be a new user
			// or a user that has not linked their account to this provider
			newIdentity = true
		} else {
			log.Error("Failed to get auth identity by provider ID", "error", err)
			http.Error(w, "Failed to get auth identity by provider ID", http.StatusInternalServerError)
			return
		}
	}

	if err == nil && (!idx.AuthUserID.Valid || idx.AuthUserID.String == "") {
		// Defensive programming here to check if the AuthUserID is empty, sqlc returns
		// zero structs even if the query returns no rows
		newIdentity = true
	}

	if !newIdentity {
		// This is an existing identity, we need to get the auth user
		au, err := queries.AuthUserByID(ctx, idx.AuthUserID.String)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
				// This should absolutely not happen, log and fail hard
				log.Error("Expected to get auth user by ID, but the user does not exist", "error", err)
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			} else {
				log.Error("Failed to get auth user by ID", "error", err)
				http.Error(w, "Failed to get auth user by ID", http.StatusInternalServerError)
			}
			return
		}
		authUser = au
	}

	// If newIdentity && newUser, we'll need to create the auth user before creating the identity.
	// This branch will try to get the auth user by email, if it exists, we'll set authUser to it.
	// If it doesn't exist, we'll set newUser to true and create a new auth user.
	if newIdentity {
		// This is a new identity, we need to check if this is a new user, we link via email
		au, err := queries.AuthUserByEmail(ctx, user.Email)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
				newUser = true
			} else {
				log.Error("Failed to get auth user by email", "error", err)
				http.Error(w, "Failed to get auth user by email", http.StatusInternalServerError)
				return
			}
		} else {
			authUser = au

			if au.EmailConfirmed {
				// This user has confirmed, which means they have a Tempest user
				// We can set the tempest user here
				tu, err := queries.TempestUserByAuthUserID(ctx, pgtype.Text{String: au.ID, Valid: true})
				if err != nil {
					if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
						// This should absolutely not happen, log and fail hard
						log.Error("Expected to get tempest user by auth user ID, but the user does not exist", "error", err)
						http.Error(w, "Internal Server Error", http.StatusInternalServerError)
					} else {
						log.Error("Failed to get tempest user by auth user ID", "error", err)
						http.Error(w, "Failed to get tempest user by auth user ID", http.StatusInternalServerError)
						return
					}
				}

				tempestUser = tu
			} else {
				// In this case, the auth user has signed up via email but not confirmed their email yet.
				// Since we know at this point if they are email verified via their provider, we can
				// set the email confirmed flag here.

				au, err := queries.ConfirmAuthUser(ctx, &bouncerepo.ConfirmAuthUserParams{
					ID:    au.ID,
					Email: au.Email,
				})
				if err != nil {
					log.Error("Expected to confirm auth user email during OAuth flow", "error", err)
					http.Error(w, "Failed to save confirmed auth user", http.StatusInternalServerError)
					return
				}

				authUser = au

				// We'll need to create a new Tempest user for them.
				tu, err := queries.CreateTempestUser(ctx, &bouncerepo.CreateTempestUserParams{
					BounceAuthUserID: pgtype.Text{String: au.ID, Valid: true},
					Email:            user.Email,
					FullName:         user.Name,
					DisplayName:      user.Name,
				})
				if err != nil {
					log.Error("Expected to create a Tempest user here as auth user exists, but email is unconfirmed", "error", err)
					http.Error(w, "Failed to create tempest user", http.StatusInternalServerError)
					return
				}

				tempestUser = tu
				newUser = false
			}
		}
	}

	if !newUser {
		// If this isn't a new user, we need to pull the Tempest user based on the auth user ID
		tu, err := queries.TempestUserByAuthUserID(ctx, pgtype.Text{String: authUser.ID, Valid: true})
		if err != nil {
			_ = expect.ExactlyOneRow(err)
			return
		}

		tempestUser = tu
	}

	if newUser {
		// This is a new user, we need to create a new user
		au, err := queries.SaveConfirmedAuthUser(ctx, user.Email)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				// This is a unique constraint violation, this means that the user was created
				// by another request. Practically speaking this is unlikely except via bug
				// or abuse. We log and fail fast.
				log.Error("Expected to create confirmed auth user, but the user already exists", "error", err)
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				return
			}

			log.Error("Failed to save confirmed auth user", "error", err)
			http.Error(w, "Failed to save confirmed auth user", http.StatusInternalServerError)
			return
		}

		if au.ID == "" || au == nil {
			log.Error("Failed to get auth user ID", "error", err)
			http.Error(w, "Failed to get auth user ID", http.StatusInternalServerError)
			return
		}

		authUser = au

		// Now to create a Tempest user
		tu, err := queries.CreateTempestUser(ctx, &bouncerepo.CreateTempestUserParams{
			BounceAuthUserID: pgtype.Text{String: au.ID, Valid: true},
			Email:            user.Email,
			FullName:         user.Name,
			DisplayName:      user.Name,
		})
		if err != nil {
			log.Error("Failed to create tempest user", "error", err)
			http.Error(w, "Failed to create tempest user", http.StatusInternalServerError)
			return
		}

		tempestUser = tu
	}

	// Regardless of the cases before this, we always save the identity after successful
	// authentication with the provider
	userData, err := user.MarshalJSON()
	if err != nil {
		log.Error("Failed to marshal user data", "error", err)
		http.Error(w, "Failed to marshal user data", http.StatusInternalServerError)
		return
	}

	tokenData, err := json.Marshal(token)
	if err != nil {
		log.Error("Failed to marshal token data", "error", err)
		http.Error(w, "Failed to marshal token data", http.StatusInternalServerError)
		return
	}

	log.Debug("Saving auth identity", "bounce.identity", idx)
	log.Debug("Saving auth identity", "bounce.auth_user", authUser)
	log.Debug("Saving auth identity", "public.user", tempestUser)
	// By now, we should have an auth user, whether new or existing
	identity, err := queries.SaveAuthIdentity(ctx, &bouncerepo.SaveAuthIdentityParams{
		AuthUserID:       pgtype.Text{String: authUser.ID, Valid: true},
		Provider:         bouncerepo.BounceIdentityProvider(p.Provider),
		ProviderID:       providerUserID,
		Email:            user.Email,
		ProviderUserData: userData,
		ProviderAppData:  tokenData,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, pgx.ErrNoRows) {
			log.Error("Failed to save auth identity", "error", err)
			http.Error(w, "Failed to save auth identity", http.StatusInternalServerError)
			return
		}

		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// This is a unique constraint violation, this means that the identity was created
			// by another request. Practically speaking this is unlikely except via bug
			// or abuse. We log and fail fast.
			log.Error("Expected to create auth identity, but the identity already exists", "error", err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}

		log.Error("Failed to save auth identity", "error", err)
		log.Debug("Auth user", "auth_user", authUser)
		http.Error(w, "Failed to save auth identity", http.StatusInternalServerError)
		return
	}

	// Finally we set the last_sign_in_at for the users
	err = queries.SetIdentityLastSignin(ctx, identity.ID)
	if err != nil {
		log.Error("Failed to update auth user last sign in at", "error", err)
		http.Error(w, "Failed to update auth user last sign in at", http.StatusInternalServerError)
		return
	}

	err = queries.SetAuthUserLastSignin(ctx, authUser.ID)
	if err != nil {
		log.Error("Failed to update auth user last sign in at", "error", err)
		http.Error(w, "Failed to update auth user last sign in at", http.StatusInternalServerError)
		return
	}

	err = tx.Commit(ctx)
	if err != nil {
		log.Error("Failed to commit transaction", "error", err)
		http.Error(w, "Failed to commit transaction", http.StatusInternalServerError)
		return
	}

	// Now we can generate a session and redirect the user to the redirect_to URL
	tc, err := NewTempestClaims(
		tempestUser.ID,
		tempestUser.Email,
	)
	if err != nil {
		log.Error("Could not create TempestClaims", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	tc.SetTempestUserID(tempestUser.ID)
	amrErr := tc.SetAMR(&AMREntry{
		Method:    "oauth2",
		Provider:  "google",
		Timestamp: time.Now().Unix(),
	})
	aalErr := tc.SetAALLevel(AAL1)
	if amrErr != nil || aalErr != nil {
		log.Error("Could not set AMR or AAL", "amr_error", amrErr, "aal_error", aalErr)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	tempestToken, err := tc.SignedString(cfg.JWTPrivateKey)
	if err != nil {
		log.Error("Could not sign JWT", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	expiresAt := tc.claims.ExpiresAt.Time
	err = setCookieTempestToken(&cfg, w, tempestToken, expiresAt)
	if err != nil {
		log.Error("Could not set cookie", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	isSignup := claims.Signup
	if newUser {
		isSignup = true
	}

	if isSignup {
		http.Redirect(w, r, cfg.RedirectURI+"/complete-setup", http.StatusFound)
		return
	}

	// Use redirect_to parameter
	redirectURL := cfg.RedirectURI + claims.RedirectTo
	log.Info("OAuth callback successful, redirecting", "userID", tempestUser.ID, "redirectURL", redirectURL)
	http.Redirect(w, r, redirectURL, http.StatusFound)
}
