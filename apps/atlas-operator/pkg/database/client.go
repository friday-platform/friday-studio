package database

import (
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

// GetUsers retrieves all users from the database.
func (c *Client) GetUsers() ([]User, error) {
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
		ORDER BY created_at DESC
	`

	var users []User
	err := c.db.Select(&users, query)
	if err != nil {
		c.logger.Error("Failed to query users",
			"error", err,
		)
		return nil, fmt.Errorf("failed to query users: %w", err)
	}

	c.logger.Debug("Retrieved users from database",
		"count", len(users),
	)

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
