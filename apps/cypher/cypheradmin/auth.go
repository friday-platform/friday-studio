package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

const (
	// Well-known gcloud OAuth client credentials (public, not sensitive).
	gcloudClientID     = "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com" //nolint:gosec
	gcloudClientSecret = "d-FL95Q19q7MQmFpd7hHD0Ty"                                                 //nolint:gosec
	callbackAddr       = "localhost:8085"
)

func isAuthError(err error) bool {
	s := err.Error()
	return strings.Contains(s, "Unauthenticated") ||
		strings.Contains(s, "invalid_grant") ||
		strings.Contains(s, "Could not find default credentials")
}

func getOAuthConfig() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     gcloudClientID,
		ClientSecret: gcloudClientSecret,
		Endpoint:     google.Endpoint,
		RedirectURL:  "http://" + callbackAddr,
		Scopes:       []string{"https://www.googleapis.com/auth/cloud-platform", "openid", "email"},
	}
}

func doOAuthLogin(ctx context.Context) (*oauth2.Token, error) {
	conf := getOAuthConfig()

	// Generate random state for CSRF protection
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return nil, fmt.Errorf("failed to generate state: %w", err)
	}
	expectedState := base64.URLEncoding.EncodeToString(stateBytes)

	codeChan := make(chan string, 1)
	errChan := make(chan error, 1)
	readyChan := make(chan struct{})

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		state := r.URL.Query().Get("state")
		errMsg := r.URL.Query().Get("error")

		switch {
		case errMsg != "":
			_, _ = fmt.Fprintf(w, "Authentication failed: %s", html.EscapeString(errMsg))
			errChan <- fmt.Errorf("oauth error: %s", errMsg)
		case code != "" && state == expectedState:
			_, _ = fmt.Fprintln(w, "Authentication successful! You can close this window.")
			codeChan <- code
		case code != "":
			_, _ = fmt.Fprintln(w, "Authentication failed: invalid state")
			errChan <- errors.New("oauth state mismatch (possible CSRF)")
		default:
			_, _ = fmt.Fprintln(w, "Waiting for OAuth callback...")
		}
	})

	// Start listener first to avoid race condition
	listener, err := net.Listen("tcp", callbackAddr)
	if err != nil {
		return nil, fmt.Errorf("failed to start callback server: %w", err)
	}

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		close(readyChan) // Signal that server is ready
		_ = server.Serve(listener)
	}()
	defer func() { _ = server.Shutdown(ctx) }()

	// Wait for server to be ready
	<-readyChan

	url := conf.AuthCodeURL(expectedState, oauth2.AccessTypeOffline, oauth2.ApprovalForce)
	fmt.Fprintln(os.Stderr, "\nOpening browser for authentication...")
	if err := openBrowser(url); err != nil {
		fmt.Fprintf(os.Stderr, "Could not open browser. Please open this URL manually:\n%s\n", url)
	}
	fmt.Fprintln(os.Stderr, "Waiting for authentication...")

	var code string
	select {
	case code = <-codeChan:
	case err := <-errChan:
		return nil, err
	case <-time.After(5 * time.Minute):
		return nil, errors.New("authentication timed out")
	}

	token, err := conf.Exchange(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("token exchange failed: %w", err)
	}

	return token, nil
}

func openBrowser(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("refusing to open non-HTTP URL: %s", u.Scheme)
	}
	validated := u.String()

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", validated) //nolint:gosec // G204: URL scheme validated above
	case "linux":
		cmd = exec.Command("xdg-open", validated) //nolint:gosec // G204: URL scheme validated above
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", validated) //nolint:gosec // G204: URL scheme validated above
	default:
		return errors.New("unsupported platform")
	}
	return cmd.Start()
}

func getTokenCachePath() string {
	configDir, _ := os.UserConfigDir()
	return filepath.Join(configDir, "cypheradmin", "token.json")
}

func loadCachedToken() *oauth2.Token {
	data, err := os.ReadFile(getTokenCachePath())
	if err != nil {
		return nil
	}
	var token oauth2.Token
	if err := json.Unmarshal(data, &token); err != nil {
		return nil
	}
	return &token
}

func saveTokenCache(token *oauth2.Token) error {
	path := getTokenCachePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(token) //nolint:gosec // G117: writing to local file cache, not exposed
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// getCachedTokenSource returns a token source from cached credentials, or nil if none exist.
func getCachedTokenSource(ctx context.Context) oauth2.TokenSource {
	token := loadCachedToken()
	if token == nil {
		return nil
	}
	return getOAuthConfig().TokenSource(ctx, token)
}
