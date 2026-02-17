package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/ggicci/httpin"
	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	bouncerepo "github.com/tempestteam/atlas/apps/bounce/repo"
	"github.com/tempestteam/atlas/apps/bounce/stripe"
	"github.com/tempestteam/atlas/pkg/analytics"
	pgxdb "github.com/tempestteam/atlas/pkg/x/middleware/pgxdb"
	pgxerr "github.com/tempestteam/atlas/pkg/x/pgxhelper"
)

const (
	SIGNUP_CONFIRMATION_SENDGRID_TEMPLATE_ID = "d-fe853da3d694420d82c4f12fb6f9bc4b"
	otpStr                                   = "otp.email:%s;otp.epoch:%d"
)

type OTP struct {
	Email     string
	CreatedAt time.Time
	sum       []byte
}

func NewOTP(email, secret string, createTime time.Time) (*OTP, error) {
	if email == "" || secret == "" {
		return nil, errors.New("email and secret are required")
	}

	var t time.Time
	if createTime.IsZero() {
		t = time.Now()
	} else {
		t = createTime
	}

	o := &OTP{
		Email:     email,
		CreatedAt: t,
	}

	h := hmac.New(sha256.New, []byte(secret))
	_, err := fmt.Fprintf(h, otpStr, email, o.CreatedAt.Unix()) //nolint:gosec // G705: writing to hmac.Hash, not http.ResponseWriter
	if err != nil {
		return nil, err
	}

	o.sum = h.Sum(nil)
	return o, nil
}

func (o *OTP) Verify(token string) (bool, error) {
	decoded, err := hex.DecodeString(token)
	if err != nil {
		return false, err
	}
	return hmac.Equal(decoded, o.sum), nil
}

func (o *OTP) String() string {
	return hex.EncodeToString(o.sum)
}

type emailSignupRequest struct {
	Payload struct {
		Email string `json:"email" validate:"required,email"`
	} `in:"body=json"`
}

// Supports GET && POST /signup/email.
func newEmailSignup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	body, err := decodeAndValidateFromRequest[emailSignupRequest](ctx, w, r)
	if err != nil {
		log.Debug("failed to decode and validate request", "error", err)
		return
	}

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("Could not retrieve config", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	// Create a new confirmation token
	otp, err := NewOTP(body.Payload.Email, cfg.SignupHMACSecret, time.Now())
	if err != nil {
		log.Error("Could not create OTP", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	otpStr := otp.String()

	expect := pgxerr.NewExpectation(
		pgxerr.WithLog(log),
		pgxerr.WithContext(ctx),
	)

	tx, queries, conn, err := queriesWithTx(ctx)
	defer expect.DeferRollbackRelease(tx, conn)
	if err != nil {
		log.Error("Could not begin transaction", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	user, err := queries.AuthUserByEmail(ctx, body.Payload.Email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
			log.Debug("User does not exist, proceeding", "email", body.Payload.Email)
		} else {
			log.Error("Could not query auth user", "error", err)
			http.Error(w, "Internal error", http.StatusInternalServerError)
			return
		}
	}

	if user.ID != "" {
		if !user.EmailConfirmed {
			// If this happens again, we'll proceed with resending the confirmation email.
			// We rely on IP rate limiting to prevent basic abuse.
			log.Info("User exists but email is not confirmed", "email", body.Payload.Email)
			if user.ConfirmationToken.String != "" &&
				user.ConfirmationSentAt.Time.IsZero() &&
				user.ConfirmationSentAt.Time.Before(time.Now().Add(-time.Minute*5)) {
				log.Info("Resending confirmation email", "email", body.Payload.Email)
			} else {
				log.Info("Confirmation email already sent", "email", body.Payload.Email)
				http.Error(w, "Confirmation email already sent", http.StatusTooEarly)
				return
			}
		} else {
			log.Info("User already exists", "email", body.Payload.Email)
			http.Error(w, "User already exists", http.StatusConflict)
			return
		}
	}

	_, err = queries.SaveUnconfirmedAuthUser(ctx, &bouncerepo.SaveUnconfirmedAuthUserParams{
		Email: body.Payload.Email,
		ConfirmationToken: pgtype.Text{
			String: otpStr,
			Valid:  true,
		},
		ConfirmationSentAt: pgtype.Timestamptz{
			Time:  otp.CreatedAt,
			Valid: true,
		},
	})
	if err != nil {
		log.Error("Could not save unconfirmed user", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	confirmationLink := cfg.SignupHostname + "/signup/email/verify?t=" + otpStr
	// Send the confirmation email

	sendgrid, err := newSendgridEmail(cfg, &SendgridEmailConfig{
		TemplateID: SIGNUP_CONFIRMATION_SENDGRID_TEMPLATE_ID,
		Data: map[string]interface{}{
			"signup_email":      body.Payload.Email,
			"confirmation_link": confirmationLink,
		},
		RecipientName:  body.Payload.Email,
		RecipientEmail: body.Payload.Email,
		SenderName:     "Friday AI",
		SenderEmail:    "login@" + cfg.EmailDomain,
	})
	if err != nil {
		log.Error("Could not create Sendgrid email", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	err = sendgrid.Send()
	if err != nil {
		log.Error("Could not send confirmation email", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	RecordEmailSent("signup")

	err = tx.Commit(ctx)
	if err != nil {
		log.Error("Could not commit transaction", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	// Return 200 OK
	w.WriteHeader(http.StatusOK)
}

type verifyEmailSignupRequest struct {
	Token string `in:"query=t" validate:"required"`
}

// GET /signup/email/verify?t=<token>.
func verifyEmailSignup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	req, err := decodeAndValidateFromRequest[verifyEmailSignupRequest](ctx, w, r)
	if err != nil {
		return
	}

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("Could not retrieve config", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	expect := pgxerr.NewExpectation(
		pgxerr.WithLog(log),
		pgxerr.WithContext(ctx),
	)

	tx, queries, conn, err := queriesWithTx(ctx)
	defer expect.DeferRollbackRelease(tx, conn)
	if err != nil {
		log.Error("Could not begin transaction", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	au, err := queries.AuthUserByConfirmationToken(ctx, pgtype.Text{String: req.Token, Valid: true})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
			log.Info("Token not found", "token", req.Token)
			RecordAuth("email", "failure")
			http.Error(w, "", http.StatusUnauthorized)
			return
		}
		log.Error("Could not query auth user by token", "error", err, "token", req.Token)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if time.Now().After(au.ConfirmationSentAt.Time.Add(time.Hour * 24)) {
		log.Info("Token has expired", "error", errors.New("token has expired"))
		RecordAuth("email", "failure")

		// Redirect to retry page--for controlled retries to prevent brute force attacks
		http.Redirect(w, r, cfg.AuthUIURL+"/signup-retry", http.StatusTemporaryRedirect)
		return
	}

	otp, err := NewOTP(au.Email, cfg.SignupHMACSecret, au.ConfirmationSentAt.Time)
	if err != nil {
		log.Error("Could not create OTP", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	verified, err := otp.Verify(req.Token)
	if err != nil {
		log.Error("Could not verify OTP", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if !verified {
		log.Info("Token did not verify contents", "token", req.Token, "email", au.Email)
		RecordAuth("email", "failure")
		http.Redirect(w, r, cfg.AuthUIURL+"/signup-retry", http.StatusTemporaryRedirect)
		return
	}

	authUser, err := queries.ConfirmAuthUser(ctx, &bouncerepo.ConfirmAuthUserParams{
		ID:    au.ID,
		Email: au.Email,
	})
	if err != nil || authUser == nil {
		log.Error("Could not confirm user", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	tu, err := claimOrCreateUser(ctx, queries, authUser.ID, authUser.Email, authUser.Email, "", "")
	if err != nil {
		log.Error("Could not create tempest user", "error", err)
		_ = expect.ExactlyOneRow(err)
		return
	}

	// User confirmed, commit and redirect to registration
	err = expect.Commit(tx)
	if err != nil {
		return
	}

	amr := &AMREntry{
		Method:    "email",
		Provider:  "atlas",
		Timestamp: time.Now().Unix(),
	}

	err = SetNewSessionCookie(ctx, w, cfg, &SessionConfig{
		User:       tu,
		AuthUser:   au,
		AMREntries: []*AMREntry{amr},
	})
	if err != nil {
		log.Error("error setting session cookie", "error", err)
		return
	}

	// This route is hosted in the SvelteKit auth-ui app at /complete-setup
	RecordAuth("email", "success")
	analytics.Emit(ctx, analytics.EventUserSignedUp, tu.ID, nil)
	http.Redirect(w, r, cfg.AuthUIURL+"/complete-setup", http.StatusTemporaryRedirect)
}

func queriesWithTx(ctx context.Context) (pgx.Tx, *bouncerepo.Queries, *pgxpool.Conn, error) {
	pool, err := pgxdb.PoolFromContext(ctx, "signup")
	if err != nil {
		return nil, nil, nil, err
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, nil, nil, err
	}

	tx, err := conn.Begin(ctx)
	if err != nil {
		return nil, nil, nil, err
	}

	repo := bouncerepo.New(conn)
	queries := repo.WithTx(tx)

	return tx, queries, conn, nil
}

func decodeAndValidateFromRequest[T any](ctx context.Context, w http.ResponseWriter, r *http.Request) (*T, error) {
	log := httplog.LogEntry(ctx)

	decoded, err := httpin.Decode[T](r)
	if err != nil {
		log.Error("Error decoding request", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return nil, err
	}

	if err := validate.Struct(decoded); err != nil {
		log.Error("Invalid request", "error", err)
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return nil, err
	}

	return decoded, nil
}

type completeSignupRequest struct {
	Payload struct {
		UserFullName string `json:"userFullName" validate:"required,min=3"`
	} `in:"body=json"`
}

func completeSignup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	req, err := decodeAndValidateFromRequest[completeSignupRequest](ctx, w, r)
	if err != nil {
		log.Error("Invalid request", "error", err)
		return
	}

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("Could not retrieve config", "error", err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}

	jwt, err := TempestTokenFromCookies(&cfg, r)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			log.Error("No JWT in cookies", "error", err)
			http.Error(w, "", http.StatusUnauthorized)
			return
		}
		log.Error("Could not retrieve JWT from cookies", "error", err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}

	tc, err := ParseTempestClaimsFromJWT(cfg.JWTPublicKey, jwt)
	if err != nil {
		log.Error("Could not parse JWT into TempestClaims", "error", err)
		http.Error(w, "", http.StatusUnauthorized)
		return
	}

	userID := tc.claims.Subject
	if userID == "" {
		log.Error("Could not retrieve user ID from JWT")
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	expect := pgxerr.NewExpectation(
		pgxerr.WithLog(log),
		pgxerr.WithContext(ctx),
	)

	// Get the pool before the request context is done - needed for async Stripe operations
	pool, err := pgxdb.PoolFromContext(ctx, "signup")
	if err != nil {
		log.Error("Could not get database pool", "error", err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}

	tx, queries, conn, err := queriesWithTx(ctx)
	defer expect.DeferRollbackRelease(tx, conn)
	if err != nil {
		log.Error("Could not begin transaction", "error", err)
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}

	user, err := queries.SaveTempestUser(ctx, &bouncerepo.SaveTempestUserParams{
		ID:           userID,
		FullName:     req.Payload.UserFullName,
		DisplayName:  req.Payload.UserFullName,
		ProfilePhoto: "",
	})
	if err != nil {
		log.Error("Could not save user", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(ctx); err != nil {
		log.Error("Could not commit transaction", "error", err)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	conn.Release()

	log.Info("User completed signup", "userID", userID, "fullName", user.FullName)
	analytics.Emit(ctx, analytics.EventUserProfileComplete, userID, nil)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, `{"success": true}`)

	// Async: Create Stripe customer (non-blocking, fire-and-forget)
	go createStripeCustomer(log, cfg, pool, user)
}

// createStripeCustomer creates a Stripe customer for the given user and stores the customer ID.
// This is a fire-and-forget operation - errors are logged but don't affect the user's signup.
func createStripeCustomer(log *slog.Logger, cfg Config, pool *pgxpool.Pool, user *bouncerepo.User) {
	sublog := log.WithGroup("create.stripe.signup").With("user_id", user.ID)

	if cfg.StripeSecretKey == "" {
		sublog.Debug("Stripe not configured, skipping customer creation")
		return
	}

	// Skip if user already has a Stripe customer (idempotency)
	if user.StripeCustomerID.Valid && user.StripeCustomerID.String != "" {
		sublog.Debug("User already has Stripe customer", "stripe_customer_id", user.StripeCustomerID.String)
		return
	}

	stripeCID, err := stripe.CreateCustomer(cfg.StripeSecretKey, user.ID, user.Email, user.FullName)
	if err != nil {
		sublog.Error("Could not create Stripe customer", "error", err)
		return
	}

	sublog.Info("Created Stripe customer", "stripe_customer_id", stripeCID)

	// Store the Stripe customer ID in the database
	// Use timeout to prevent hanging during shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dbConn, err := pool.Acquire(ctx)
	if err != nil {
		sublog.Error("Could not acquire database connection", "error", err)
		return
	}
	defer dbConn.Release()

	repo := bouncerepo.New(dbConn)
	err = repo.UpdateUserStripeCustomerID(ctx, &bouncerepo.UpdateUserStripeCustomerIDParams{
		ID:               user.ID,
		StripeCustomerID: pgtype.Text{String: stripeCID, Valid: true},
	})
	if err != nil {
		sublog.Error("Could not save Stripe customer ID", "error", err)
		return
	}

	sublog.Info("Saved Stripe customer ID to database")
}

// claimOrCreateUser tries to claim a pre-provisioned pool user first, falling back to direct creation.
func claimOrCreateUser(
	ctx context.Context,
	queries *bouncerepo.Queries,
	authUserID, email, fullName, displayName, profilePhoto string,
) (*bouncerepo.User, error) {
	log := httplog.LogEntry(ctx)

	user, err := queries.ClaimPoolUser(ctx, &bouncerepo.ClaimPoolUserParams{
		Email:            email,
		FullName:         fullName,
		BounceAuthUserID: pgtype.Text{String: authUserID, Valid: true},
		DisplayName:      displayName,
		ProfilePhoto:     profilePhoto,
	})
	if err == nil {
		log.Info("Claimed pool user", "user_id", user.ID)
		return user, nil
	}

	if errors.Is(err, pgx.ErrNoRows) {
		log.Info("Pool empty, creating user directly")
	} else {
		log.Warn("Pool claim failed, creating user directly", "error", err)
	}

	return queries.CreateTempestUser(ctx, &bouncerepo.CreateTempestUserParams{
		BounceAuthUserID: pgtype.Text{String: authUserID, Valid: true},
		Email:            email,
		FullName:         fullName,
		DisplayName:      displayName,
	})
}
