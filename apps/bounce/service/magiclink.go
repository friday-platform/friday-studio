package service

import (
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5/pgtype"
	bouncerepo "github.com/tempestteam/atlas/apps/bounce/repo"
	pgxerr "github.com/tempestteam/atlas/pkg/x/pgxhelper"
)

const MAGIC_LINK_SENDGRID_TEMPLATE_ID = "d-fe853da3d694420d82c4f12fb6f9bc4b"

type magicLinkRequest struct {
	Payload struct {
		Email            string `json:"email" validate:"required,email"`
		OriginalReferrer string `json:"original_referrer,omitempty"`
	} `in:"body=json"`
}

func magicLinkURL(cfg Config, otp, originalReferrer string) string {
	u := fmt.Sprintf("%s/magiclink/verify?otp=%s", cfg.BounceServiceURL, otp)
	if originalReferrer != "" {
		u += fmt.Sprintf("&original_referrer=%s", url.QueryEscape(originalReferrer))
	}
	return u
}

// sendMagicLink sends a magic link to the user's email address.
// This is a public route that doesn't go through forwardauth.
// It needs to be rate limited by Traefik.
// As currently implemented, it's vulnerable to enumeration via.
// timing attacks, as the difference between finding a user or not.
// results in some measurable processing time.
// This could be mitigated by using a constant time comparison.
// or by adding some jitter to the response time when a user is not found.
// Or, @lcf had a great idea to drop the request off in a queue.
// https://linear.app/tempestteam/issue/TEM-2234/protect-magic-links-from-timing-enumeration-attack
func sendMagicLink(w http.ResponseWriter, r *http.Request) {
	log := httplog.LogEntry(r.Context())
	cfg, err := ConfigFromContext(r.Context())
	if err != nil {
		log.Error("error getting config from context", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	req, err := decodeAndValidateFromRequest[magicLinkRequest](r.Context(), w, r)
	if err != nil {
		log.Debug("Failed to decode and validate magic-link request", "request", req)
		return
	}

	expect := pgxerr.NewExpectation(
		pgxerr.WithLog(log),
	)

	// First, lets check if a bounce.auth user with this email exists
	tx, queries, conn, err := queriesWithTx(r.Context())
	defer expect.DeferRollbackRelease(tx, conn)
	if err != nil {
		log.Error("error getting db connection", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	user, err := queries.AuthUserByEmail(r.Context(), req.Payload.Email)
	if err != nil {
		log.Error("error getting user by email", "error", err)
		_ = expect.ExactlyOneRow(err)
		return
	}

	// Check for duplicate magic link - if query succeeds, a valid unexpired link exists
	_, err = queries.ValidMagicLinkOTPByAuthUserID(r.Context(), pgtype.Text{String: user.ID, Valid: true})
	if err == nil {
		// Valid magic link already exists, don't send another one
		log.Info("valid magic link already exists for user", "user_id", user.ID, "email", user.Email)
		w.WriteHeader(http.StatusOK)
		return
	}
	// No valid OTP exists (query returned error), proceed to create a new one

	otp, err := NewOTP(user.Email, cfg.SignupHMACSecret, time.Now())
	if err != nil {
		log.Error("error creating OTP", "error", err)
		w.WriteHeader(http.StatusOK)
		return
	}

	_, err = queries.SaveOTP(r.Context(), &bouncerepo.SaveOTPParams{
		Token:         otp.String(),
		Use:           bouncerepo.BounceOtpUseMagiclink,
		AuthUserID:    pgtype.Text{String: user.ID, Valid: true},
		CreatedAt:     pgtype.Timestamptz{Time: otp.CreatedAt, Valid: true},
		NotValidAfter: pgtype.Timestamptz{Time: otp.CreatedAt.Add(time.Minute * 15), Valid: true},
	})
	if err != nil {
		log.Error("error saving OTP", "error", err)
		_ = expect.ExactlyOneRow(err)
		return
	}

	err = expect.Commit(tx)
	if err != nil {
		return
	}

	email, err := newSendgridEmail(cfg, &SendgridEmailConfig{
		TemplateID: MAGIC_LINK_SENDGRID_TEMPLATE_ID,
		Data: map[string]interface{}{
			"login_link":  magicLinkURL(cfg, otp.String(), req.Payload.OriginalReferrer),
			"login_email": user.Email,
		},
		RecipientName:  user.Email,
		RecipientEmail: user.Email,
	})
	if err != nil {
		log.Error("error sending email", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	err = email.Send()
	if err != nil {
		log.Error("error sending email", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

type verifyMagicLinkRequest struct {
	OTP string `in:"query=otp" validate:"required"`
}

func verifyMagicLink(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)
	req, err := decodeAndValidateFromRequest[verifyMagicLinkRequest](ctx, w, r)
	if err != nil {
		log.Debug("Failed to decode and validate magic-link request", "request", req)
		return
	}

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("error getting config from context", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	expect := pgxerr.NewExpectation(
		pgxerr.WithLog(log),
		pgxerr.WithContext(ctx),
	)

	tx, queries, conn, err := queriesWithTx(ctx)
	defer expect.DeferRollbackRelease(tx, conn)
	if err != nil {
		log.Error("error getting db connection", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	otp, err := queries.UseOTP(ctx, req.OTP)
	if err != nil {
		log.Error("error using OTP", "error", err)
		_ = expect.ExactlyOneRow(err)

		msg := url.QueryEscape("magic link expired")

		http.Redirect(w, r, cfg.AuthUIURL+"/error?msg="+msg, http.StatusFound)
		return
	}

	if otp.Use != bouncerepo.BounceOtpUseMagiclink {
		log.Error("Expected a magic link OTP, but got something else", "otp", otp, "use", otp.Use)
		w.WriteHeader(http.StatusOK)
		return
	}

	if otp.NotValidAfter.Time.Before(time.Now()) {
		log.Error("Magic link OTP is expired", "otp", otp)
		http.Error(w, "Magic link expired. Please request another one", http.StatusGone)
		return
	}

	// Get the user
	au, err := queries.AuthUserByID(ctx, otp.AuthUserID.String)
	if err != nil {
		log.Error("error getting user by ID", "error", err)
		_ = expect.ExactlyOneRow(err)
		return
	}

	// While we have already verified that this OTP was previously generated
	// and stored in the database, and that the user has presented it to us,
	// we perform this additional check to ensure that it's a valid OTP that was
	// generated by bounce. This protects against attacks where an attacker might have
	// access to the database, but not the application or secrets store where the HMAC key is stored.
	// Defense in depth!
	dbOTP, err := NewOTP(au.Email, cfg.SignupHMACSecret, otp.CreatedAt.Time)
	if err != nil {
		log.Error("error creating OTP to validate", "error", err)
		w.WriteHeader(http.StatusOK)
		return
	}

	valid, err := dbOTP.Verify(req.OTP)
	if err != nil {
		log.Error("error verifying OTP", "error", err)
		w.WriteHeader(http.StatusOK)
		return
	}

	if !valid {
		log.Error("Magic link OTP is invalid", "otp", req.OTP)
		w.WriteHeader(http.StatusOK)
		return
	}

	// get the Tempest user
	tu, err := queries.TempestUserByAuthUserID(ctx, pgtype.Text{String: au.ID, Valid: true})
	if err != nil {
		log.Error("error getting Tempest user by AuthUserID", "error", err)
		_ = expect.ExactlyOneRow(err)
		return
	}

	err = expect.Commit(tx)
	if err != nil {
		return
	}

	// Create a new session
	amr := &AMREntry{
		Method:    "magiclink",
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

	// Redirect to default URI
	redirectURL := cfg.RedirectURI + "/"
	log.Info("Magic link verification successful, redirecting", "userID", tu.ID, "redirectURL", redirectURL)
	http.Redirect(w, r, redirectURL, http.StatusFound)
}
