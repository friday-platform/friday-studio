package service

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"

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
	maxSubjectLength = 998     // RFC 2822 maximum
	maxContentLength = 5242880 // 5MB
	maxTemplateIDLen = 100     // Reasonable limit for template IDs
)

// templateIDRegex validates SendGrid template IDs (alphanumeric with hyphens).
var templateIDRegex = regexp.MustCompile(`^[a-zA-Z0-9\-]+$`)

// Whitelist of allowed custom email headers.
var allowedCustomHeaders = map[string]bool{
	"X-Atlas-User":      true,
	"X-Atlas-Session":   true,
	"X-Atlas-Workspace": true,
	"X-Atlas-Agent":     true,
	"X-Priority":        true,
	"X-MSMail-Priority": true,
	"Importance":        true,
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
	if _, err := mail.ParseAddress(req.From); err != nil {
		return fmt.Errorf("invalid email format: from")
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

	if err := validateSendEmailRequest(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	message := s.buildSendGridMessage(&req)

	// Retry with exponential backoff
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

		w.WriteHeader(resp.StatusCode)
		if _, err := w.Write([]byte(resp.Body)); err != nil {
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

func (s *Service) buildSendGridMessage(req *SendEmailRequest) *sgmail.SGMailV3 {
	from := sgmail.NewEmail(req.FromName, req.From)
	to := sgmail.NewEmail("", req.To)

	message := sgmail.NewV3Mail()
	message.SetFrom(from)
	message.Subject = req.Subject

	// Add personalization
	p := sgmail.NewPersonalization()
	p.AddTos(to)

	// Template support
	if req.TemplateID != "" {
		message.SetTemplateID(req.TemplateID)
		for k, v := range req.TemplateData {
			p.SetDynamicTemplateData(k, v)
		}
	} else {
		message.AddContent(sgmail.NewContent(detectContentType(req.Content), req.Content))
	}

	message.AddPersonalizations(p)

	// IP Pool
	message.SetIPPoolID(defaultIPPoolName)

	// Custom headers
	for k, v := range s.buildCustomHeaders(req) {
		message.SetHeader(k, v)
	}

	// Attachments
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

	// Sandbox mode
	if req.SandboxMode {
		mailSettings := sgmail.NewMailSettings()
		mailSettings.SetSandboxMode(sgmail.NewSetting(true))
		message.SetMailSettings(mailSettings)
	}

	return message
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
