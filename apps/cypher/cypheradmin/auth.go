package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
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

func doOAuthLogin(ctx context.Context) error {
	conf := &oauth2.Config{
		ClientID:     gcloudClientID,
		ClientSecret: gcloudClientSecret,
		Endpoint:     google.Endpoint,
		RedirectURL:  "http://" + callbackAddr,
		Scopes:       []string{"https://www.googleapis.com/auth/cloud-platform", "openid", "email"},
	}

	// Generate random state for CSRF protection
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return fmt.Errorf("failed to generate state: %w", err)
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
			_, _ = fmt.Fprintf(w, "Authentication failed: %s", errMsg)
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
		return fmt.Errorf("failed to start callback server: %w", err)
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
		return err
	case <-time.After(5 * time.Minute):
		return errors.New("authentication timed out")
	}

	token, err := conf.Exchange(ctx, code)
	if err != nil {
		return fmt.Errorf("token exchange failed: %w", err)
	}

	return saveADC(token.RefreshToken)
}

func saveADC(refreshToken string) error {
	adc := map[string]string{
		"client_id":     gcloudClientID,
		"client_secret": gcloudClientSecret,
		"refresh_token": refreshToken,
		"type":          "authorized_user",
	}

	adcPath := getADCPath()
	if err := os.MkdirAll(filepath.Dir(adcPath), 0o700); err != nil {
		return err
	}

	f, err := os.Create(adcPath) //nolint:gosec
	if err != nil {
		return err
	}

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	encErr := enc.Encode(adc)
	closeErr := f.Close()
	if encErr != nil {
		return encErr
	}
	if closeErr != nil {
		return closeErr
	}

	fmt.Fprintf(os.Stderr, "Credentials saved to: %s\n", adcPath)
	return nil
}

func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		return errors.New("unsupported platform")
	}
	return cmd.Start()
}

func getADCPath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("APPDATA"), "gcloud", "application_default_credentials.json")
	}
	configDir, _ := os.UserConfigDir()
	return filepath.Join(configDir, "gcloud", "application_default_credentials.json")
}
