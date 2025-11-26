package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq" // postgres driver
)

// User represents a user from the database.
type User struct {
	ID               string    `db:"id"`
	BounceAuthUserID *string   `db:"bounce_auth_user_id"`
	FullName         *string   `db:"full_name"`
	Email            *string   `db:"email"`
	CreatedAt        time.Time `db:"created_at"`
	UpdatedAt        time.Time `db:"updated_at"`
	DisplayName      *string   `db:"display_name"`
	ProfilePhoto     *string   `db:"profile_photo"`
}

// Client manages database connections and queries.
type Client struct {
	db     *sqlx.DB
	logger *slog.Logger
}

// NewClient creates a new database client.
func NewClient(databaseURL string, logger *slog.Logger) (*Client, error) {
	// Parse and validate connection string
	db, err := sqlx.Connect("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to database: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(3 * time.Minute)

	// Test connection
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	logger.Info("Connected to database",
		"max_open_conns", 10,
	)

	return &Client{
		db:     db,
		logger: logger,
	}, nil
}

// GetUsers retrieves users from the database with cursor-based pagination.
// Use afterID="" for the first page. Returns up to limit users ordered by id.
func (c *Client) GetUsers(ctx context.Context, limit int, afterID string) ([]User, error) {
	query := `
		SELECT
			id,
			bounce_auth_user_id,
			full_name,
			email,
			created_at,
			updated_at,
			display_name,
			profile_photo
		FROM "user"
		WHERE ($1 = '' OR id > $1)
		ORDER BY id
		LIMIT $2
	`

	var users []User
	err := c.db.SelectContext(ctx, &users, query, afterID, limit)
	if err != nil {
		c.logger.Error("Failed to query users",
			"error", err,
		)
		return nil, fmt.Errorf("failed to query users: %w", err)
	}

	return users, nil
}

// GetUser retrieves a specific user by ID.
func (c *Client) GetUser(userID string) (*User, error) {
	query := `
		SELECT
			id,
			bounce_auth_user_id,
			full_name,
			email,
			created_at,
			updated_at,
			display_name,
			profile_photo
		FROM "user"
		WHERE id = $1
		LIMIT 1
	`

	var user User
	err := c.db.Get(&user, query, userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // User not found
		}
		c.logger.Error("Failed to query user",
			"error", err,
			"user_id", userID,
		)
		return nil, fmt.Errorf("failed to query user: %w", err)
	}

	return &user, nil
}

// Close closes the database connection.
func (c *Client) Close() error {
	if c.db != nil {
		return c.db.Close()
	}
	return nil
}

// Health checks the database connection health.
func (c *Client) Health() error {
	if c.db == nil {
		return fmt.Errorf("database connection not initialized")
	}
	return c.db.Ping()
}

// CountPoolUsers counts available pool users that are unclaimed.
func (c *Client) CountPoolUsers(ctx context.Context) (int, error) {
	query := `SELECT COUNT(*) FROM "user" WHERE pool_available = true`

	var count int
	err := c.db.GetContext(ctx, &count, query)
	if err != nil {
		return 0, fmt.Errorf("failed to count pool users: %w", err)
	}

	return count, nil
}

// CreatePoolUser creates a new pool user with placeholder data.
// Returns the user ID of the created pool user.
func (c *Client) CreatePoolUser(ctx context.Context) (string, error) {
	query := `
		INSERT INTO "user" (email, full_name, pool_available)
		VALUES (gen_random_uuid()::text || '@pool.internal', '', true)
		RETURNING id
	`

	var userID string
	err := c.db.GetContext(ctx, &userID, query)
	if err != nil {
		return "", fmt.Errorf("failed to create pool user: %w", err)
	}

	return userID, nil
}
