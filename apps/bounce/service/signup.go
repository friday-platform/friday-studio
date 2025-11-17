package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/ggicci/httpin"
	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	bouncerepo "github.com/tempestteam/atlas/apps/bounce/repo"
	pgxdb "github.com/tempestteam/atlas/pkg/x/middleware/pgxdb"
	pgxerr "github.com/tempestteam/atlas/pkg/x/pgxhelper"
)

const (
	SIGNUP_CONFIRMATION_SENDGRID_TEMPLATE_ID = "d-5e52d757929b4b94afae4c725e210672"
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
	_, err := fmt.Fprintf(h, otpStr, email, o.CreatedAt.Unix())
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
		SenderName:     "Atlas",
		SenderEmail:    "noreply@" + cfg.EmailDomain,
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
			http.Error(w, "", http.StatusUnauthorized)
			return
		}
		log.Error("Could not query auth user by token", "error", err, "token", req.Token)
		http.Error(w, "Internal error", http.StatusInternalServerError)
		return
	}

	if time.Now().After(au.ConfirmationSentAt.Time.Add(time.Hour * 24)) {
		log.Info("Token has expired", "error", errors.New("token has expired"))

		// Redirect to retry page--for controlled retries to prevent brute force attacks
		http.Redirect(w, r, cfg.RedirectURI+"/signup-retry", http.StatusTemporaryRedirect)
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
		http.Redirect(w, r, cfg.RedirectURI+"/signup-retry", http.StatusTemporaryRedirect)
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

	tu, err := queries.CreateTempestUser(ctx, &bouncerepo.CreateTempestUserParams{
		BounceAuthUserID: pgtype.Text{String: authUser.ID, Valid: true},
		Email:            authUser.Email,
		// We haven't asked for a full name yet, so we'll use the email for now
		// To get past the NOT NULL constraint
		FullName: authUser.Email,
	})
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
		Provider:  "tempest",
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

	// This route is hosted in the SvelteKit app at app.tempestdx.*/setup
	http.Redirect(w, r, cfg.RedirectURI+"/complete-setup", http.StatusTemporaryRedirect)
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
