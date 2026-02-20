package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	secretmanager "cloud.google.com/go/secretmanager/apiv1"
	"cloud.google.com/go/secretmanager/apiv1/secretmanagerpb"
	"golang.org/x/oauth2"
	"google.golang.org/api/option"
)

const jwtSecretName = "atlas-jwt-private-key-pem" //nolint:gosec // Not a credential, just a secret name.

func detectProject() string {
	for _, env := range []string{"GOOGLE_CLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT", "GCLOUD_PROJECT"} {
		if p := os.Getenv(env); p != "" {
			return p
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	activeConfig := "default"
	activeConfigPath := filepath.Join(home, ".config", "gcloud", "active_config")
	if data, err := os.ReadFile(activeConfigPath); err == nil { //nolint:gosec
		activeConfig = strings.TrimSpace(string(data))
	}

	configPath := filepath.Join(home, ".config", "gcloud", "configurations", "config_"+activeConfig)
	f, err := os.Open(configPath) //nolint:gosec
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()

	scanner := bufio.NewScanner(f)
	inCore := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case line == "[core]":
			inCore = true
		case strings.HasPrefix(line, "["):
			inCore = false
		case inCore && strings.HasPrefix(line, "project"):
			if parts := strings.SplitN(line, "=", 2); len(parts) == 2 {
				return strings.TrimSpace(parts[1])
			}
		}
	}
	return ""
}

func fetchSecret(ctx context.Context, project, secretName string, tokenSource oauth2.TokenSource) (string, error) {
	var opts []option.ClientOption
	if tokenSource != nil {
		opts = append(opts, option.WithTokenSource(tokenSource))
	}

	client, err := secretmanager.NewClient(ctx, opts...)
	if err != nil {
		return "", err
	}
	defer func() { _ = client.Close() }()

	name := fmt.Sprintf("projects/%s/secrets/%s/versions/latest", project, secretName)
	result, err := client.AccessSecretVersion(ctx, &secretmanagerpb.AccessSecretVersionRequest{Name: name})
	if err != nil {
		return "", err
	}
	return string(result.Payload.Data), nil
}
