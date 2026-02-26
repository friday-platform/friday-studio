package service

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/jackc/pgx/v5/pgtype"
	bouncerepo "github.com/tempestteam/atlas/apps/bounce/repo"
	"github.com/tempestteam/atlas/pkg/analytics"
	pgxerr "github.com/tempestteam/atlas/pkg/x/pgxhelper"
)

const MAGIC_LINK_SENDGRID_TEMPLATE_ID = "d-2dfcc0e1598c4bdabc5254649f2a7153"

type magicLinkRequest struct {
	Payload struct {
		Email            string `json:"email" validate:"required,email"`
		OriginalReferrer string `json:"original_referrer,omitempty"`
	} `in:"body=json"`
}

func magicLinkURL(cfg Config, otp, originalReferrer string) string {
	u := fmt.Sprintf("%s/magiclink/verify?otp=%s", cfg.BounceServiceURL, url.QueryEscape(otp))
	if originalReferrer != "" {
		u += fmt.Sprintf("&original_referrer=%s", url.QueryEscape(originalReferrer))
	}
	return u
}

// sendMagicLink sends a magic link email. Public route, not behind forwardauth.
// Vulnerable to timing enumeration — see TEM-2234 for mitigation plan.
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

	// Deduplicate: if a valid unexpired link already exists, don't send another
	existingOTP, err := queries.ValidMagicLinkOTPByAuthUserID(r.Context(), pgtype.Text{String: user.ID, Valid: true})
	if err == nil {
		log.Info("valid magic link already exists for user", "user_id", user.ID, "email", user.Email)
		setMLSessionCookie(w, cfg, existingOTP.Token)
		w.WriteHeader(http.StatusOK)
		return
	}

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
		Data: map[string]any{
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

	RecordEmailSent("magiclink")
	setMLSessionCookie(w, cfg, otp.String())
	w.WriteHeader(http.StatusOK)
}

// GET /magiclink/verify?otp=<token> — redirects to auth-ui confirmation page.
// Does NOT consume the token. GET-to-POST split blocks most scanners.
func verifyMagicLink(w http.ResponseWriter, r *http.Request) {
	cfg, err := ConfigFromContext(r.Context())
	if err != nil {
		httplog.LogEntry(r.Context()).Error("error getting config from context", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	otp := r.URL.Query().Get("otp")
	if otp == "" {
		http.Redirect(w, r, cfg.AuthUIURL+"/", http.StatusTemporaryRedirect)
		return
	}

	w.Header().Set("Referrer-Policy", "no-referrer")

	redirect := cfg.AuthUIURL + "/confirm-login?otp=" + url.QueryEscape(otp)
	if ref := r.URL.Query().Get("original_referrer"); ref != "" {
		redirect += "&original_referrer=" + url.QueryEscape(ref)
	}

	http.Redirect(w, r, redirect, http.StatusTemporaryRedirect)
}

type verifyMagicLinkPostRequest struct {
	Payload struct {
		OTP              string `json:"otp" validate:"required"`
		OriginalReferrer string `json:"original_referrer,omitempty"`
	} `in:"body=json"`
}

// POST /magiclink/verify — consumes the token and returns JSON.
func verifyMagicLinkPost(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	req, err := decodeAndValidateFromRequest[verifyMagicLinkPostRequest](ctx, w, r)
	if err != nil {
		return
	}

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("error getting config from context", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Session binding: verify the browser that requested the magic link is the
	// one completing verification. Scanners follow GET links from emails but
	// never call POST /magiclink, so they lack this cookie.
	if err := validateMLSessionCookie(r, cfg, req.Payload.OTP); err != nil {
		log.Warn("ML session cookie check failed", "error", err)
		RecordAuth("magiclink", "failure")
		writeJSON(w, http.StatusForbidden, map[string]string{
			"error": "Please use the link from your email",
			"code":  "verification_failed",
		})
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

	// Read the OTP without consuming — validate type and expiry before burning the token.
	otp, err := queries.GetUnusedOTP(ctx, req.Payload.OTP)
	if err != nil {
		log.Error("error looking up OTP", "error", err)
		RecordAuth("magiclink", "failure")
		writeJSON(w, http.StatusGone, map[string]string{
			"error": "Magic link expired or already used",
			"code":  "token_consumed",
		})
		return
	}

	if otp.Use != bouncerepo.BounceOtpUseMagiclink {
		log.Error("Expected a magic link OTP, but got something else", "otp", otp, "use", otp.Use)
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Invalid token",
			"code":  "token_invalid",
		})
		return
	}

	if otp.NotValidAfter.Time.Before(time.Now()) {
		log.Error("Magic link OTP is expired", "otp", otp)
		RecordAuth("magiclink", "failure")
		writeJSON(w, http.StatusGone, map[string]string{
			"error": "Magic link expired",
			"code":  "token_expired",
		})
		return
	}

	au, err := queries.AuthUserByID(ctx, otp.AuthUserID.String)
	if err != nil {
		log.Error("error getting user by ID", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Internal error",
			"code":  "internal",
		})
		return
	}

	// Defense in depth: verify the OTP was generated by bounce using the HMAC secret.
	// Protects against database-only compromise where the attacker lacks the secret.
	dbOTP, err := NewOTP(au.Email, cfg.SignupHMACSecret, otp.CreatedAt.Time)
	if err != nil {
		log.Error("error creating OTP to validate", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Internal error",
			"code":  "internal",
		})
		return
	}

	valid, err := dbOTP.Verify(req.Payload.OTP)
	if err != nil {
		log.Error("error verifying OTP", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Internal error",
			"code":  "internal",
		})
		return
	}

	if !valid {
		log.Error("Magic link OTP is invalid", "otp", req.Payload.OTP)
		RecordAuth("magiclink", "failure")
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "Invalid token",
			"code":  "token_invalid",
		})
		return
	}

	// All checks passed — consume the token atomically.
	// Race: if consumed between SELECT and UPDATE, UseOTP returns no rows.
	_, err = queries.UseOTP(ctx, req.Payload.OTP)
	if err != nil {
		log.Error("error consuming OTP", "error", err)
		RecordAuth("magiclink", "failure")
		writeJSON(w, http.StatusGone, map[string]string{
			"error": "Magic link expired or already used",
			"code":  "token_consumed",
		})
		return
	}

	tu, err := queries.TempestUserByAuthUserID(ctx, pgtype.Text{String: au.ID, Valid: true})
	if err != nil {
		log.Error("error getting Tempest user by AuthUserID", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Internal error",
			"code":  "internal",
		})
		return
	}

	err = expect.Commit(tx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "Internal error",
			"code":  "internal",
		})
		return
	}

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
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	redirectURL := cfg.RedirectURI + "/"
	if ref := req.Payload.OriginalReferrer; ref != "" {
		if strings.HasPrefix(ref, "/") {
			redirectURL = cfg.RedirectURI + ref
		}
	}

	log.Info("Magic link verification successful", "userID", tu.ID, "redirectURL", redirectURL)
	RecordAuth("magiclink", "success")
	analytics.Emit(ctx, analytics.EventUserLoggedIn, tu.ID, nil)
	writeJSON(w, http.StatusOK, map[string]string{
		"redirect": redirectURL,
	})
}
