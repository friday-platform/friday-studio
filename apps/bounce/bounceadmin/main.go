package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
)

var (
	project    string
	email      string
	authUserID string
)

func main() {
	rootCmd := &cobra.Command{
		Use:   "bounceadmin",
		Short: "Admin tool for bounce auth service",
	}

	sessionCmd := &cobra.Command{
		Use:   "session <user-id>",
		Short: "Generate a friday_token session JWT for a user",
		Args:  cobra.ExactArgs(1),
		Run:   runSession,
	}
	sessionCmd.Flags().StringVarP(&project, "project", "p", "", "GCP project (default: from env or gcloud config)")
	sessionCmd.Flags().StringVarP(&email, "email", "e", "", "Email for JWT claims (required)")
	sessionCmd.Flags().StringVarP(&authUserID, "auth-user-id", "a", "", "Bounce auth user ID (defaults to user-id)")
	_ = sessionCmd.MarkFlagRequired("email")

	rootCmd.AddCommand(sessionCmd)

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runSession(cmd *cobra.Command, args []string) {
	userID := args[0]

	if authUserID == "" {
		authUserID = userID
	}

	if project == "" {
		project = detectProject()
		if project == "" {
			fmt.Fprintln(os.Stderr, "error: could not detect GCP project")
			fmt.Fprintln(os.Stderr, "hint: set GOOGLE_CLOUD_PROJECT env var or use --project flag")
			os.Exit(1)
		}
	}

	fmt.Fprintf(os.Stderr, "Using GCP project: %s\n", project)

	ctx := context.Background()

	tokenSource := getCachedTokenSource(ctx)
	privateKeyPEM, err := fetchSecret(ctx, project, jwtSecretName, tokenSource)
	if err != nil && isAuthError(err) {
		fmt.Fprintln(os.Stderr, "Authentication required. Starting OAuth flow...")
		oauthToken, authErr := doOAuthLogin(ctx)
		if authErr != nil {
			fmt.Fprintf(os.Stderr, "error: OAuth failed: %v\n", authErr)
			os.Exit(1)
		}
		if cacheErr := saveTokenCache(oauthToken); cacheErr != nil {
			fmt.Fprintf(os.Stderr, "warning: failed to cache token: %v\n", cacheErr)
		}
		tokenSource = getOAuthConfig().TokenSource(ctx, oauthToken)
		privateKeyPEM, err = fetchSecret(ctx, project, jwtSecretName, tokenSource)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to fetch secret: %v\n", err)
		os.Exit(1)
	}

	privateKey, err := parsePrivateKey(privateKeyPEM)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to parse private key: %v\n", err)
		os.Exit(1)
	}

	jwtToken, expiresAt, err := generateSessionJWT(privateKey, userID, authUserID, email)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to generate JWT: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "Generated friday_token for user %s <%s> (expires: %s)\n", userID, email, expiresAt.Format(time.RFC3339))
	fmt.Fprintf(os.Stderr, "Set as cookie: friday_token=%s\n", jwtToken[:40]+"...")
	fmt.Println(jwtToken)
}
