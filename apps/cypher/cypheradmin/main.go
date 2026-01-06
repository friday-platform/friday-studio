package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
)

var (
	project string
	email   string
)

func main() {
	rootCmd := &cobra.Command{
		Use:   "cypheradmin",
		Short: "Admin tool for cypher service",
	}

	generateCmd := &cobra.Command{
		Use:   "generate <user-id>",
		Short: "Generate an ATLAS_KEY for a user",
		Args:  cobra.ExactArgs(1),
		Run:   runGenerate,
	}
	generateCmd.Flags().StringVarP(&project, "project", "p", "", "GCP project (default: from env or gcloud config)")
	generateCmd.Flags().StringVarP(&email, "email", "e", "", "Optional email for JWT claims")

	rootCmd.AddCommand(generateCmd)

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func runGenerate(cmd *cobra.Command, args []string) {
	userID := args[0]

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

	privateKeyPEM, err := fetchSecret(ctx, project, jwtSecretName)
	if err != nil && isAuthError(err) {
		fmt.Fprintln(os.Stderr, "Authentication required. Starting OAuth flow...")
		if authErr := doOAuthLogin(ctx); authErr != nil {
			fmt.Fprintf(os.Stderr, "error: OAuth failed: %v\n", authErr)
			os.Exit(1)
		}
		privateKeyPEM, err = fetchSecret(ctx, project, jwtSecretName)
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

	token, expiresAt, err := generateJWT(privateKey, userID, email)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to generate JWT: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "Generated ATLAS_KEY for user %s (expires: %s)\n", userID, expiresAt.Format(time.RFC3339))
	fmt.Println(token)
}
