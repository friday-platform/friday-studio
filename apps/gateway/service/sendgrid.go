package service

import (
	"encoding/json"
	"fmt"
	"html"
	"math"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/httplog/v2"
	"github.com/google/uuid"
	"github.com/k3a/html2text"
	"github.com/sendgrid/rest"
	"github.com/sendgrid/sendgrid-go"
	sgmail "github.com/sendgrid/sendgrid-go/helpers/mail"
)

const defaultIPPoolName = "tempest-atlas"

// Retry configuration - variables allow test overrides.
var (
	maxRetryAttempts = 10
	minRetryDelay    = 5 * time.Second
	maxRetryDelay    = 20 * time.Second
	retryMultiplier  = 2.0
)

// Validation limits.
var (
	maxSubjectLength    = 998     // RFC 2822 maximum
	maxContentLength    = 5242880 // 5MB
	maxTemplateIDLen    = 100     // Reasonable limit for template IDs
	maxWorkspaceIDLen   = 100
	invalidWorkspaceMsg = "invalid workspace_id: must not contain '|' and be <= 100 chars"
)

// templateIDRegex validates SendGrid template IDs (alphanumeric with hyphens).
var templateIDRegex = regexp.MustCompile(`^[a-zA-Z0-9\-]+$`)

// Whitelist of allowed custom email headers.
var allowedCustomHeaders = map[string]bool{
	"X-Atlas-Session":    true,
	"X-Friday-Workspace": true,
	"X-Atlas-Agent":      true,
	"X-Priority":         true,
	"X-MSMail-Priority":  true,
	"Importance":         true,
}

// Attachment represents an email attachment from the client request.
type Attachment struct {
	Content     string `json:"content"`
	Type        string `json:"type"`
	Filename    string `json:"filename"`
	Disposition string `json:"disposition,omitempty"`
}

// SendEmailRequest is the incoming request from clients.
type SendEmailRequest struct {
	To             string                 `json:"to"`
	From           string                 `json:"from,omitempty"`
	FromName       string                 `json:"from_name,omitempty"`
	Subject        string                 `json:"subject"`
	Content        string                 `json:"content"`
	TemplateID     string                 `json:"template_id,omitempty"`
	TemplateData   map[string]interface{} `json:"template_data,omitempty"`
	Attachments    []Attachment           `json:"attachments,omitempty"`
	SandboxMode    bool                   `json:"sandbox_mode,omitempty"`
	ClientHostname string                 `json:"client_hostname,omitempty"`
	CustomHeaders  map[string]string      `json:"custom_headers,omitempty"`
	WorkspaceID    string                 `json:"workspace_id,omitempty"`
}

// validateSendEmailRequest validates email request fields.
func validateSendEmailRequest(req *SendEmailRequest) error {
	if req.To == "" {
		return fmt.Errorf("missing required field: to")
	}
	if req.From == "" {
		return fmt.Errorf("missing required field: from")
	}
	if req.Subject == "" {
		return fmt.Errorf("missing required field: subject")
	}
	if req.Content == "" && req.TemplateID == "" {
		return fmt.Errorf("missing required: content or template_id")
	}

	if _, err := mail.ParseAddress(req.To); err != nil {
		return fmt.Errorf("invalid email format: to")
	}
	if strings.HasSuffix(strings.ToLower(req.To), "@pool.internal") {
		return fmt.Errorf("invalid recipient: internal pool address")
	}
	if _, err := mail.ParseAddress(req.From); err != nil {
		return fmt.Errorf("invalid email format: from")
	}
	if strings.HasSuffix(strings.ToLower(req.From), "@pool.internal") {
		return fmt.Errorf("invalid sender: internal pool address")
	}

	if len(req.Subject) > maxSubjectLength {
		return fmt.Errorf("subject exceeds maximum length of %d characters", maxSubjectLength)
	}
	if len(req.Content) > maxContentLength {
		return fmt.Errorf("content exceeds maximum length of %d bytes", maxContentLength)
	}

	if req.TemplateID != "" {
		if len(req.TemplateID) > maxTemplateIDLen {
			return fmt.Errorf("template_id exceeds maximum length of %d characters", maxTemplateIDLen)
		}
		if !templateIDRegex.MatchString(req.TemplateID) {
			return fmt.Errorf("invalid template_id format (alphanumeric and hyphens only)")
		}
	}

	return nil
}

func (s *Service) HandleSendGridEmail(w http.ResponseWriter, r *http.Request) {
	var req SendEmailRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	userID := userIDFromContext(r.Context())

	// Resolve real email when the JWT contains a stale pool placeholder.
	// Pool-provisioned pods get JWTs with @pool.internal emails that are never
	// refreshed after the user claims the pod, so we look up the current email
	// from the database and replace it in the request.
	// Runs BEFORE validateSendEmailRequest so resolved emails pass validation
	// while the defense-in-depth @pool.internal rejection in validation only
	// catches code paths that bypass resolution.
	if s.emailCache != nil && isPoolEmail(req.To) {
		resolvedEmail, err := s.emailCache.Resolve(r.Context(), userID)
		switch {
		case err != nil:
			log := httplog.LogEntry(r.Context())
			log.Error("failed to resolve pool email from DB",
				"error", err, "to", req.To)
			http.Error(w, "failed to resolve recipient email", http.StatusServiceUnavailable)
			return
		case isPoolEmail(resolvedEmail):
			http.Error(w, "cannot send email: user account not yet activated", http.StatusUnprocessableEntity)
			return
		default:
			log := httplog.LogEntry(r.Context())
			log.Warn("replaced stale pool email with current email",
				"original", req.To, "resolved", resolvedEmail)
			req.To = resolvedEmail
		}
	}

	if err := validateSendEmailRequest(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	workspaceID := resolveWorkspaceID(&req)
	if workspaceID != "" && (strings.Contains(workspaceID, "|") || len(workspaceID) > maxWorkspaceIDLen) {
		http.Error(w, invalidWorkspaceMsg, http.StatusBadRequest)
		return
	}

	if workspaceID == "" {
		workspaceID = uuid.NewString()
		s.Logger.Warn("email sent without workspace ID, using fallback", "fallbackID", workspaceID)
	}

	logFields := map[string]any{
		"emailTo":      req.To,
		"emailFrom":    req.From,
		"emailSubject": req.Subject,
		"workspaceID":  workspaceID,
	}
	httplog.LogEntrySetFields(r.Context(), logFields)

	if s.isEmailSuppressed(r.Context(), req.To, workspaceID) {
		s.Logger.Info("email suppressed (recipient unsubscribed)", "to", req.To, "workspaceID", workspaceID)
		emailSuppressionsTotal.Inc()
		recordSendGridRequest(http.StatusOK)
		w.WriteHeader(http.StatusOK)
		return
	}

	message := s.buildSendGridMessage(&req, workspaceID, userID)

	var lastErr error
	for attempt := 1; attempt <= maxRetryAttempts; attempt++ {
		resp, err := s.sendToSendGrid(r, message)
		if err != nil {
			lastErr = err
			if attempt < maxRetryAttempts {
				delay := calculateRetryDelay(attempt)
				s.Logger.Warn("sendgrid request failed, retrying",
					"attempt", attempt,
					"max_attempts", maxRetryAttempts,
					"retry_after", delay,
					"error", err)
				select {
				case <-r.Context().Done():
					http.Error(w, "request cancelled", http.StatusServiceUnavailable)
					return
				case <-time.After(delay):
				}
				continue
			}
			break
		}
		recordSendGridRequest(resp.StatusCode)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		if _, err := w.Write([]byte(resp.Body)); err != nil { //nolint:gosec // G705: Content-Type set to application/json above
			s.Logger.Error("failed to write response body", "error", err)
		}
		return
	}

	s.Logger.Error("sendgrid request failed after retries",
		"attempts", maxRetryAttempts,
		"error", lastErr)
	recordSendGridRequest(http.StatusBadGateway)
	http.Error(w, fmt.Sprintf("failed to send email after %d attempts", maxRetryAttempts), http.StatusBadGateway)
}

func (s *Service) buildSendGridMessage(req *SendEmailRequest, workspaceID, userID string) *sgmail.SGMailV3 {
	from := sgmail.NewEmail(req.FromName, req.From)
	to := sgmail.NewEmail("", req.To)

	message := sgmail.NewV3Mail()
	message.SetFrom(from)
	message.Subject = req.Subject

	p := sgmail.NewPersonalization()
	p.AddTos(to)

	unsubURL := s.unsubscribeURL(req.To, workspaceID, userID)

	if req.TemplateID != "" {
		message.SetTemplateID(req.TemplateID)
		for k, v := range req.TemplateData {
			p.SetDynamicTemplateData(k, v)
		}
	} else {
		content := req.Content
		if unsubURL != "" && detectContentType(content) == "text/html" {
			content = injectUnsubscribeLink(content, unsubURL)
		}
		addEmailContent(message, content)
	}

	message.AddPersonalizations(p)

	message.SetIPPoolID(defaultIPPoolName)

	for k, v := range s.buildCustomHeaders(req) {
		message.SetHeader(k, v)
	}

	// List-Unsubscribe headers (RFC 8058)
	if unsubURL != "" {
		message.SetHeader("List-Unsubscribe", "<"+unsubURL+">")
		message.SetHeader("List-Unsubscribe-Post", "List-Unsubscribe=One-Click")
	}

	for _, att := range req.Attachments {
		a := sgmail.NewAttachment()
		a.SetContent(att.Content)
		a.SetType(att.Type)
		a.SetFilename(att.Filename)
		if att.Disposition != "" {
			a.SetDisposition(att.Disposition)
		}
		message.AddAttachment(a)
	}

	if req.SandboxMode {
		mailSettings := sgmail.NewMailSettings()
		mailSettings.SetSandboxMode(sgmail.NewSetting(true))
		message.SetMailSettings(mailSettings)
	}

	return message
}

// resolveWorkspaceID returns workspace ID from the request body field or X-Friday-Workspace header.
func resolveWorkspaceID(req *SendEmailRequest) string {
	if req.WorkspaceID != "" {
		return req.WorkspaceID
	}
	return req.CustomHeaders["X-Friday-Workspace"]
}

// unsubscribeURL generates a signed unsubscribe URL if the feature is configured.
// Returns "" when userID is empty — we can't generate a valid unsubscribe token
// without a user (FK constraint on email_suppressions.user_id).
func (s *Service) unsubscribeURL(email, workspaceID, userID string) string {
	if workspaceID == "" || userID == "" || s.cfg.UnsubscribeBaseURL == "" || s.cfg.UnsubscribeHMACKey == "" {
		return ""
	}
	token := generateUnsubscribeToken(s.cfg.UnsubscribeHMACKey, email, workspaceID, userID)
	return s.cfg.UnsubscribeBaseURL + "/unsubscribe?token=" + url.QueryEscape(token)
}

// injectUnsubscribeLink appends an unsubscribe link before the closing </body> or </html> tag.
func injectUnsubscribeLink(content, unsubURL string) string {
	link := `<p style="font-size: 11px; margin-top: 4px; text-align: center;"><a href="` + html.EscapeString(unsubURL) + `" style="color: #888; text-decoration: underline;">Unsubscribe from this workspace</a></p>`

	for _, tag := range []string{"</body>", "</html>"} {
		if idx := strings.LastIndex(strings.ToLower(content), tag); idx != -1 {
			return content[:idx] + link + content[idx:]
		}
	}

	return content + link
}

// sendGridHost allows overriding the SendGrid API host for testing.
var sendGridHost = ""

func (s *Service) sendToSendGrid(r *http.Request, message *sgmail.SGMailV3) (*rest.Response, error) {
	request := sendgrid.GetRequest(s.cfg.SendGridAPIKey, "/v3/mail/send", sendGridHost)
	request.Method = "POST"
	client := &sendgrid.Client{Request: request}

	resp, err := client.SendWithContext(r.Context(), message)
	if err != nil {
		return nil, fmt.Errorf("sendgrid request failed: %w", err)
	}

	if shouldRetry(resp.StatusCode) {
		return nil, fmt.Errorf("sendgrid returned %d: %s", resp.StatusCode, resp.Body)
	}

	return resp, nil
}

func (s *Service) buildCustomHeaders(req *SendEmailRequest) map[string]string {
	headers := make(map[string]string)

	if req.ClientHostname != "" {
		headers["X-Atlas-Hostname"] = strings.ToLower(sanitizeHeader(req.ClientHostname))
	}

	for k, v := range req.CustomHeaders {
		if allowedCustomHeaders[k] {
			headers[k] = sanitizeHeader(v)
		} else {
			s.Logger.Warn("blocked disallowed custom header", "header", k, "value", v)
		}
	}

	return headers
}

// sanitizeHeader removes CRLF characters to prevent SMTP header injection.
func sanitizeHeader(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", "")
	return s
}

// detectContentType returns the appropriate MIME type for email content.
func detectContentType(content string) string {
	mimeType := http.DetectContentType([]byte(content))
	if strings.HasPrefix(mimeType, "text/html") {
		return "text/html"
	}
	return "text/plain"
}

// addEmailContent adds content to the message as multipart/alternative when HTML.
// For HTML content, includes both plain text (generated from HTML) and HTML versions.
// Plain text must come first per RFC 2046 for proper email client rendering.
func addEmailContent(message *sgmail.SGMailV3, content string) {
	if detectContentType(content) == "text/html" {
		plainText := html2text.HTML2TextWithOptions(content,
			html2text.WithLinksInnerText(), // "Click here <url>" preserves link text
			html2text.WithUnixLineBreaks(), // Consistent \n line breaks
		)
		// Order matters: plain text first, then HTML (RFC 2046)
		message.AddContent(sgmail.NewContent("text/plain", plainText))
		message.AddContent(sgmail.NewContent("text/html", content))
	} else {
		message.AddContent(sgmail.NewContent("text/plain", content))
	}
}

func calculateRetryDelay(attempt int) time.Duration {
	delay := float64(minRetryDelay) * math.Pow(retryMultiplier, float64(attempt-1))
	if delay > float64(maxRetryDelay) {
		delay = float64(maxRetryDelay)
	}
	return time.Duration(delay)
}

func shouldRetry(statusCode int) bool {
	return statusCode == http.StatusTooManyRequests || (statusCode >= 500 && statusCode < 600)
}
