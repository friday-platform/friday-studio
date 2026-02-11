package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"html"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/tempestteam/atlas/apps/gateway/repo"
)

// tokenTTL is how long an unsubscribe token remains valid.
const tokenTTL = 30 * 24 * time.Hour // 30 days

// unsubscribeTokenPayload is the cleartext portion of a token: email|workspace_id|user_id|unix_ts.
type unsubscribeTokenPayload struct {
	Email       string
	WorkspaceID string
	UserID      string
	Timestamp   int64
}

// generateUnsubscribeToken creates an HMAC-SHA256 signed token encoding email, workspace, user ID, and timestamp.
// Format: hex(hmac) + "." + email + "|" + workspaceID + "|" + userID + "|" + unix_timestamp.
func generateUnsubscribeToken(hmacKey, email, workspaceID, userID string) string {
	email = strings.ToLower(email)
	ts := time.Now().Unix()
	payload := fmt.Sprintf("%s|%s|%s|%d", email, workspaceID, userID, ts)

	mac := hmac.New(sha256.New, []byte(hmacKey))
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))

	return sig + "." + payload
}

// verifyUnsubscribeToken validates the HMAC signature and TTL.
func verifyUnsubscribeToken(hmacKey, token string) (*unsubscribeTokenPayload, error) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("malformed token")
	}

	sig, payload := parts[0], parts[1]

	mac := hmac.New(sha256.New, []byte(hmacKey))
	mac.Write([]byte(payload))
	expected := mac.Sum(nil)

	decoded, err := hex.DecodeString(sig)
	if err != nil {
		return nil, fmt.Errorf("malformed signature")
	}

	if !hmac.Equal(decoded, expected) {
		return nil, fmt.Errorf("invalid signature")
	}

	fields := strings.SplitN(payload, "|", 4)
	if len(fields) != 4 {
		return nil, fmt.Errorf("malformed payload")
	}

	var ts int64
	if _, err := fmt.Sscanf(fields[3], "%d", &ts); err != nil {
		return nil, fmt.Errorf("malformed timestamp")
	}

	if time.Since(time.Unix(ts, 0)) > tokenTTL {
		return nil, fmt.Errorf("token expired")
	}

	return &unsubscribeTokenPayload{
		Email:       fields[0],
		WorkspaceID: fields[1],
		UserID:      fields[2],
		Timestamp:   ts,
	}, nil
}

// isEmailSuppressed checks whether the recipient has unsubscribed from the given workspace.
func (s *Service) isEmailSuppressed(ctx context.Context, email, workspaceID string) bool {
	if s.queries == nil {
		return false
	}

	exists, err := s.queries.IsEmailSuppressed(ctx, repo.IsEmailSuppressedParams{
		Email:       strings.ToLower(email),
		WorkspaceID: workspaceID,
	})
	if err != nil {
		s.Logger.Error("suppression check failed", "error", err, "email", email, "workspaceID", workspaceID)
		return false // fail open — don't silently drop emails on DB errors
	}

	return exists
}

// storeSuppression inserts an email suppression inside a transaction with RLS context.
// The user_id column is populated via its DEFAULT (current_setting('request.user_id')).
func (s *Service) storeSuppression(ctx context.Context, email, workspaceID, userID, remoteIP string) error {
	return withUserContext(ctx, s.db, userID, func(q *repo.Queries) error {
		return q.StoreSuppression(ctx, repo.StoreSuppressionParams{
			Email:       strings.ToLower(email),
			WorkspaceID: workspaceID,
			RemoteIp:    remoteIP,
		})
	})
}

// HandleUnsubscribe handles RFC 8058 one-click unsubscribe (POST /unsubscribe).
func (s *Service) HandleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	log := httplog.LogEntry(r.Context())

	token := r.FormValue("token")
	if token == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}

	payload, err := verifyUnsubscribeToken(s.cfg.UnsubscribeHMACKey, token)
	if err != nil {
		log.Warn("invalid unsubscribe token", "error", err)
		http.Error(w, "invalid or expired link", http.StatusBadRequest)
		return
	}

	remoteIP := stripPort(r.RemoteAddr)
	if err := s.storeSuppression(r.Context(), payload.Email, payload.WorkspaceID, payload.UserID, remoteIP); err != nil {
		log.Error("failed to store suppression", "error", err)
		unsubscribeRequestsTotal.WithLabelValues("POST", "error").Inc()
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	log.Info("email unsubscribed",
		"email", payload.Email,
		"workspaceID", payload.WorkspaceID,
		"userID", payload.UserID,
		"remoteIP", remoteIP)
	unsubscribeRequestsTotal.WithLabelValues("POST", "ok").Inc()
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprint(w, "You have been unsubscribed.")
}

// HandleUnsubscribePage handles visible unsubscribe link clicks (GET /unsubscribe).
// It verifies the token and renders a confirmation form that POSTs back to /unsubscribe.
// The GET itself does NOT store a suppression — this prevents email link scanners
// (Barracuda, Mimecast, SafeLinks) from auto-unsubscribing recipients.
func (s *Service) HandleUnsubscribePage(w http.ResponseWriter, r *http.Request) {
	log := httplog.LogEntry(r.Context())

	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}

	payload, err := verifyUnsubscribeToken(s.cfg.UnsubscribeHMACKey, token)
	if err != nil {
		log.Warn("invalid unsubscribe token", "error", err)
		unsubscribeRequestsTotal.WithLabelValues("GET", "invalid").Inc()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprint(w, unsubscribeErrorPage)
		return
	}

	displayName := workspaceDisplayName(payload.WorkspaceID)
	unsubscribeRequestsTotal.WithLabelValues("GET", "rendered").Inc()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = fmt.Fprintf(w, unsubscribeConfirmPage, html.EscapeString(displayName), html.EscapeString(token))
}

// workspaceDisplayName returns a human-readable name for a workspace ID.
func workspaceDisplayName(workspaceID string) string {
	if workspaceID == "friday-conversation" {
		return "chat"
	}
	return workspaceID
}

// stripPort returns just the IP from a host:port address.
// If there's no port (e.g. middleware.RealIP already stripped it), returns as-is.
func stripPort(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr // already bare IP
	}
	return host
}

const unsubscribeConfirmPage = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb;color:#181c2f}
.card{text-align:center;padding:48px;max-width:400px}h1{font-size:24px;margin-bottom:8px}p{color:#6b7280;line-height:1.5}
button{margin-top:24px;padding:12px 32px;font-size:16px;background:#181c2f;color:#fff;border:none;border-radius:6px;cursor:pointer}button:hover{background:#2d3348}</style>
</head>
<body><div class="card"><h1>Unsubscribe from %s?</h1><p>You will no longer receive emails from this workspace. Other Friday notifications are unaffected.</p>
<form method="POST" action="/unsubscribe"><input type="hidden" name="token" value="%s"><button type="submit">Confirm Unsubscribe</button></form></div></body>
</html>`

const unsubscribeErrorPage = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invalid Link</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb;color:#181c2f}
.card{text-align:center;padding:48px;max-width:400px}h1{font-size:24px;margin-bottom:8px}p{color:#6b7280;line-height:1.5}</style>
</head>
<body><div class="card"><h1>Invalid Link</h1><p>This unsubscribe link is invalid or has expired. Please use the link from a more recent email.</p></div></body>
</html>`
