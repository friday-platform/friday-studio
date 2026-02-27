package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/spf13/cobra"
)

var (
	createUserName string
	postgresConn   string
)

func runCreateUser(cmd *cobra.Command, args []string) {
	userID, err := createUser()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(userID)
}

func createUser() (string, error) {
	connStr := postgresConn
	if connStr == "" {
		connStr = os.Getenv("POSTGRES_CONNECTION")
	}
	if connStr == "" {
		return "", fmt.Errorf("database connection string required\nhint: set POSTGRES_CONNECTION env var or use --postgres flag")
	}

	ctx := context.Background()

	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		return "", fmt.Errorf("failed to connect to database: %w", err)
	}
	defer func() { _ = conn.Close(ctx) }()

	tx, err := conn.Begin(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var authUserID string
	err = tx.QueryRow(ctx,
		`INSERT INTO bounce.auth_user (email, email_confirmed, email_confirmed_at)
		 VALUES ($1, true, now())
		 RETURNING id`,
		email,
	).Scan(&authUserID)
	if err != nil {
		return "", fmt.Errorf("failed to create auth user: %w", err)
	}

	var userID string
	err = tx.QueryRow(ctx,
		`INSERT INTO public."user" (bounce_auth_user_id, email, full_name)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		authUserID, email, createUserName,
	).Scan(&userID)
	if err != nil {
		return "", fmt.Errorf("failed to create user: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", fmt.Errorf("failed to commit transaction: %w", err)
	}

	fmt.Fprintf(os.Stderr, "Created user %s <%s> (auth: %s)\n", userID, email, authUserID)
	return userID, nil
}
