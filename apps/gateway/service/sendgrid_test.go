package service

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	sgmail "github.com/sendgrid/sendgrid-go/helpers/mail"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateSendEmailRequest(t *testing.T) {
	tests := []struct {
		name    string
		req     SendEmailRequest
		wantErr string
	}{
		{
			name:    "missing to",
			req:     SendEmailRequest{From: "sender@example.com", Subject: "test", Content: "hello"},
			wantErr: "missing required field: to",
		},
		{
			name:    "missing from",
			req:     SendEmailRequest{To: "test@example.com", Subject: "test", Content: "hello"},
			wantErr: "missing required field: from",
		},
		{
			name:    "missing subject",
			req:     SendEmailRequest{To: "test@example.com", From: "sender@example.com", Content: "hello"},
			wantErr: "missing required field: subject",
		},
		{
			name:    "missing content and template",
			req:     SendEmailRequest{To: "test@example.com", From: "sender@example.com", Subject: "test"},
			wantErr: "missing required: content or template_id",
		},
		{
			name:    "invalid to email",
			req:     SendEmailRequest{To: "not-an-email", From: "sender@example.com", Subject: "test", Content: "hello"},
			wantErr: "invalid email format: to",
		},
		{
			name:    "invalid from email",
			req:     SendEmailRequest{To: "test@example.com", From: "bad", Subject: "test", Content: "hello"},
			wantErr: "invalid email format: from",
		},
		{
			name: "subject too long",
			req: SendEmailRequest{
				To:      "test@example.com",
				From:    "sender@example.com",
				Subject: string(make([]byte, 1000)),
				Content: "hello",
			},
			wantErr: "subject exceeds maximum length",
		},
		{
			name: "invalid template_id format",
			req: SendEmailRequest{
				To:         "test@example.com",
				From:       "sender@example.com",
				Subject:    "test",
				TemplateID: "template with spaces!",
			},
			wantErr: "invalid template_id format",
		},
		{
			name: "pool.internal recipient rejected",
			req: SendEmailRequest{
				To:      "abc123@pool.internal",
				From:    "sender@example.com",
				Subject: "test",
				Content: "hello",
			},
			wantErr: "invalid recipient: internal pool address",
		},
		{
			name: "pool.internal recipient rejected case insensitive",
			req: SendEmailRequest{
				To:      "ABC@POOL.INTERNAL",
				From:    "sender@example.com",
				Subject: "test",
				Content: "hello",
			},
			wantErr: "invalid recipient: internal pool address",
		},
		{
			name: "pool.internal sender rejected",
			req: SendEmailRequest{
				To:      "user@example.com",
				From:    "abc123@pool.internal",
				Subject: "test",
				Content: "hello",
			},
			wantErr: "invalid sender: internal pool address",
		},
		{
			name: "pool.internal sender rejected case insensitive",
			req: SendEmailRequest{
				To:      "user@example.com",
				From:    "ABC@POOL.INTERNAL",
				Subject: "test",
				Content: "hello",
			},
			wantErr: "invalid sender: internal pool address",
		},
		{
			name: "valid with content",
			req: SendEmailRequest{
				To:      "test@example.com",
				From:    "sender@example.com",
				Subject: "test",
				Content: "hello world",
			},
			wantErr: "",
		},
		{
			name: "valid with template",
			req: SendEmailRequest{
				To:         "test@example.com",
				From:       "sender@example.com",
				Subject:    "test",
				TemplateID: "d-abc123",
			},
			wantErr: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateSendEmailRequest(&tt.req)
			if tt.wantErr == "" {
				assert.NoError(t, err)
			} else {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
			}
		})
	}
}

func TestDetectContentType(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "plain text",
			content: "Hello, this is plain text",
			want:    "text/plain",
		},
		{
			name:    "html with doctype",
			content: "<!DOCTYPE html><html><body>Hello</body></html>",
			want:    "text/html",
		},
		{
			name:    "html without doctype",
			content: "<html><body>Hello</body></html>",
			want:    "text/html",
		},
		{
			name:    "html fragment",
			content: "<div><p>Hello world</p></div>",
			want:    "text/html", // http.DetectContentType detects HTML tags
		},
		{
			name:    "empty string",
			content: "",
			want:    "text/plain",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectContentType(tt.content)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestCalculateRetryDelay(t *testing.T) {
	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 1, want: 5 * time.Second},
		{attempt: 2, want: 10 * time.Second},
		{attempt: 3, want: 20 * time.Second},
		{attempt: 4, want: 20 * time.Second}, // capped at max
		{attempt: 10, want: 20 * time.Second},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("attempt_%d", tt.attempt), func(t *testing.T) {
			got := calculateRetryDelay(tt.attempt)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestShouldRetry(t *testing.T) {
	tests := []struct {
		status int
		want   bool
	}{
		{status: http.StatusOK, want: false},
		{status: http.StatusCreated, want: false},
		{status: http.StatusBadRequest, want: false},
		{status: http.StatusUnauthorized, want: false},
		{status: http.StatusForbidden, want: false},
		{status: http.StatusNotFound, want: false},
		{status: http.StatusTooManyRequests, want: true},
		{status: http.StatusInternalServerError, want: true},
		{status: http.StatusBadGateway, want: true},
		{status: http.StatusServiceUnavailable, want: true},
		{status: http.StatusGatewayTimeout, want: true},
	}

	for _, tt := range tests {
		t.Run(http.StatusText(tt.status), func(t *testing.T) {
			got := shouldRetry(tt.status)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestSanitizeHeader(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "no special chars",
			input: "normal header value",
			want:  "normal header value",
		},
		{
			name:  "with CR",
			input: "value\rwith\rCR",
			want:  "valuewithCR",
		},
		{
			name:  "with LF",
			input: "value\nwith\nLF",
			want:  "valuewithLF",
		},
		{
			name:  "with CRLF",
			input: "value\r\nwith\r\nCRLF",
			want:  "valuewithCRLF",
		},
		{
			name:  "header injection attempt",
			input: "value\r\nX-Injected: malicious",
			want:  "valueX-Injected: malicious",
		},
		{
			name:  "empty string",
			input: "",
			want:  "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeHeader(tt.input)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestTemplateIDRegex(t *testing.T) {
	tests := []struct {
		id    string
		valid bool
	}{
		{id: "d-abc123", valid: true},
		{id: "template-name-123", valid: true},
		{id: "UPPERCASE", valid: true},
		{id: "123456", valid: true},
		{id: "a", valid: true},
		{id: "template with spaces", valid: false},
		{id: "template@special!", valid: false},
		{id: "template\nnewline", valid: false},
		{id: "", valid: false},
	}

	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			got := templateIDRegex.MatchString(tt.id)
			assert.Equal(t, tt.valid, got)
		})
	}
}

func TestAddEmailContent(t *testing.T) {
	tests := []struct {
		name              string
		content           string
		expectedContents  int
		expectedFirstType string
		expectedLastType  string
	}{
		{
			name:              "HTML content adds both plain and HTML",
			content:           "<html><body><h1>Hello</h1><p>World</p></body></html>",
			expectedContents:  2,
			expectedFirstType: "text/plain",
			expectedLastType:  "text/html",
		},
		{
			name:              "plain text content adds only plain",
			content:           "Hello, this is plain text",
			expectedContents:  1,
			expectedFirstType: "text/plain",
			expectedLastType:  "text/plain",
		},
		{
			name:              "HTML with links preserves URLs in plain text",
			content:           `<p>Visit <a href="https://example.com">our site</a></p>`,
			expectedContents:  2,
			expectedFirstType: "text/plain",
			expectedLastType:  "text/html",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			message := sgmail.NewV3Mail()
			addEmailContent(message, tt.content)

			require.Len(t, message.Content, tt.expectedContents)
			assert.Equal(t, tt.expectedFirstType, message.Content[0].Type)
			assert.Equal(t, tt.expectedLastType, message.Content[len(message.Content)-1].Type)

			// For HTML content, verify plain text doesn't contain HTML tags
			if tt.expectedContents == 2 {
				plainContent := message.Content[0].Value
				assert.NotContains(t, plainContent, "<html>")
				assert.NotContains(t, plainContent, "<body>")
				assert.NotContains(t, plainContent, "<p>")
			}
		})
	}
}

func TestAddEmailContentPreservesLinks(t *testing.T) {
	html := `<html><body><p>Click <a href="https://example.com/path">here</a> for more info.</p></body></html>`

	message := sgmail.NewV3Mail()
	addEmailContent(message, html)

	require.Len(t, message.Content, 2)

	plainText := message.Content[0].Value
	// WithLinksInnerText preserves link text: "here <url>"
	assert.Contains(t, plainText, "here")
	assert.Contains(t, plainText, "https://example.com/path")
}

func TestAddEmailContentWithTable(t *testing.T) {
	html := `<table><tr><th>Name</th><th>Value</th></tr><tr><td>Item</td><td>$10</td></tr></table>`

	message := sgmail.NewV3Mail()
	addEmailContent(message, html)

	require.Len(t, message.Content, 2)

	plainText := message.Content[0].Value
	// Table cell text is extracted (formatting is basic but content preserved)
	assert.Contains(t, plainText, "Name")
	assert.Contains(t, plainText, "Item")
}

func TestResolveWorkspaceID(t *testing.T) {
	tests := []struct {
		name   string
		req    SendEmailRequest
		wantID string
	}{
		{
			name:   "from body field",
			req:    SendEmailRequest{WorkspaceID: "ws-body"},
			wantID: "ws-body",
		},
		{
			name: "from custom header",
			req: SendEmailRequest{
				CustomHeaders: map[string]string{"X-Friday-Workspace": "ws-header"},
			},
			wantID: "ws-header",
		},
		{
			name: "body takes precedence over header",
			req: SendEmailRequest{
				WorkspaceID:   "ws-body",
				CustomHeaders: map[string]string{"X-Friday-Workspace": "ws-header"},
			},
			wantID: "ws-body",
		},
		{
			name:   "empty when neither set",
			req:    SendEmailRequest{},
			wantID: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveWorkspaceID(&tt.req)
			assert.Equal(t, tt.wantID, got)
		})
	}
}

func TestBuildSendGridMessage_ListUnsubscribeHeaders(t *testing.T) {
	svc := &Service{
		Logger: testLogger(),
		cfg: Config{
			SendGridAPIKey:     "test-key",
			UnsubscribeHMACKey: "test-hmac-key",
			UnsubscribeBaseURL: "https://gateway.test",
		},
		client: &http.Client{},
	}

	t.Run("headers present when workspace and user ID provided", func(t *testing.T) {
		req := &SendEmailRequest{
			To:      "user@example.com",
			From:    "sender@example.com",
			Subject: "Test",
			Content: "<html><body>Hello</body></html>",
		}

		msg := svc.buildSendGridMessage(req, "ws-123", "usr123")

		// Check List-Unsubscribe header
		listUnsub := msg.Headers["List-Unsubscribe"]
		assert.NotEmpty(t, listUnsub)
		assert.Contains(t, listUnsub, "https://gateway.test/unsubscribe?token=")
		assert.True(t, listUnsub[0] == '<', "should be wrapped in angle brackets")

		// Check List-Unsubscribe-Post header
		assert.Equal(t, "List-Unsubscribe=One-Click", msg.Headers["List-Unsubscribe-Post"])
	})

	t.Run("headers absent when no user ID", func(t *testing.T) {
		req := &SendEmailRequest{
			To:      "user@example.com",
			From:    "sender@example.com",
			Subject: "Test",
			Content: "Hello",
		}

		msg := svc.buildSendGridMessage(req, "ws-123", "")

		assert.Empty(t, msg.Headers["List-Unsubscribe"])
		assert.Empty(t, msg.Headers["List-Unsubscribe-Post"])
	})

	t.Run("headers absent when no workspace ID", func(t *testing.T) {
		req := &SendEmailRequest{
			To:      "user@example.com",
			From:    "sender@example.com",
			Subject: "Test",
			Content: "Hello",
		}

		msg := svc.buildSendGridMessage(req, "", "usr123")

		assert.Empty(t, msg.Headers["List-Unsubscribe"])
		assert.Empty(t, msg.Headers["List-Unsubscribe-Post"])
	})

	t.Run("headers absent when HMAC key not configured", func(t *testing.T) {
		noKeySvc := &Service{
			Logger: testLogger(),
			cfg:    Config{SendGridAPIKey: "test-key"},
			client: &http.Client{},
		}

		req := &SendEmailRequest{
			To:      "user@example.com",
			From:    "sender@example.com",
			Subject: "Test",
			Content: "Hello",
		}

		msg := noKeySvc.buildSendGridMessage(req, "ws-123", "usr123")

		assert.Empty(t, msg.Headers["List-Unsubscribe"])
		assert.Empty(t, msg.Headers["List-Unsubscribe-Post"])
	})
}

func TestInjectUnsubscribeLink(t *testing.T) {
	unsubURL := "https://gateway.test/unsubscribe?token=abc123"

	t.Run("injects before closing body tag", func(t *testing.T) {
		content := `<html><body><p>Hello</p></body></html>`
		result := injectUnsubscribeLink(content, unsubURL)

		assert.Contains(t, result, unsubURL)
		// Link should appear before </body>
		linkIdx := strings.Index(result, "Unsubscribe from this workspace")
		bodyIdx := strings.Index(result, "</body>")
		assert.Less(t, linkIdx, bodyIdx)
	})

	t.Run("appends when no body tag", func(t *testing.T) {
		content := `<div>Hello</div>`
		result := injectUnsubscribeLink(content, unsubURL)

		assert.Contains(t, result, unsubURL)
		assert.True(t, strings.HasSuffix(result, "</a></p>"))
	})
}
