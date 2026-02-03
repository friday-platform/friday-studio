package database

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/phuslu/lru"
	"github.com/tempestteam/atlas/apps/atlas-operator/repo"
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
	pool            *pgxpool.Pool
	queries         *repo.Queries
	logger          *slog.Logger
	virtualKeyCache *lru.TTLCache[string, struct{}]
}

// NewClient creates a new database client.
func NewClient(databaseURL string, logger *slog.Logger) (*Client, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database URL: %w", err)
	}

	// Configure connection pool
	config.MaxConns = 10
	config.MinConns = 2
	config.MaxConnLifetime = 5 * time.Minute
	config.MaxConnIdleTime = 3 * time.Minute

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		return nil, fmt.Errorf("create connection pool: %w", err)
	}

	// Test connection
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	logger.Info("Connected to database",
		"max_conns", config.MaxConns,
	)

	return &Client{
		pool:            pool,
		queries:         repo.New(pool),
		logger:          logger,
		virtualKeyCache: lru.NewTTLCache[string, struct{}](4096),
	}, nil
}

// GetUsers retrieves users from the database with cursor-based pagination.
// Use afterID="" for the first page. Returns up to limit users ordered by id.
func (c *Client) GetUsers(ctx context.Context, limit int, afterID string) ([]User, error) {
	// Cap limit to a reasonable maximum to prevent overflow
	if limit > 10000 {
		limit = 10000
	}
	if limit < 0 {
		limit = 0
	}

	// Use separate queries to avoid OR that defeats index usage.
	if afterID == "" {
		return c.getUsersFirstPage(ctx, int32(limit)) //nolint:gosec // limit is bounded above
	}
	return c.getUsersAfterCursor(ctx, int32(limit), afterID) //nolint:gosec // limit is bounded above
}

func (c *Client) getUsersFirstPage(ctx context.Context, limit int32) ([]User, error) {
	rows, err := c.queries.GetUsersFirstPage(ctx, limit)
	if err != nil {
		c.logger.Error("Failed to query users", "error", err)
		return nil, fmt.Errorf("query users: %w", err)
	}

	users := make([]User, len(rows))
	for i, row := range rows {
		users[i] = userFromFirstPageRow(row)
	}
	return users, nil
}

func (c *Client) getUsersAfterCursor(ctx context.Context, limit int32, afterID string) ([]User, error) {
	rows, err := c.queries.GetUsersAfterCursor(ctx, &repo.GetUsersAfterCursorParams{
		Column1: afterID,
		Limit:   limit,
	})
	if err != nil {
		c.logger.Error("Failed to query users", "error", err)
		return nil, fmt.Errorf("query users: %w", err)
	}

	users := make([]User, len(rows))
	for i, row := range rows {
		users[i] = userFromAfterCursorRow(row)
	}
	return users, nil
}

// GetUser retrieves a specific user by ID.
func (c *Client) GetUser(ctx context.Context, userID string) (*User, error) {
	row, err := c.queries.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil // User not found
		}
		c.logger.Error("Failed to query user",
			"error", err,
			"user_id", userID,
		)
		return nil, fmt.Errorf("query user: %w", err)
	}

	user := userFromByIDRow(row)
	return &user, nil
}

// Close closes the database connection.
func (c *Client) Close() error {
	if c.pool != nil {
		c.pool.Close()
	}
	return nil
}

// Health checks the database connection health.
func (c *Client) Health() error {
	if c.pool == nil {
		return fmt.Errorf("database connection not initialized")
	}
	return c.pool.Ping(context.Background())
}

// CountPoolUsers counts available pool users that are unclaimed.
func (c *Client) CountPoolUsers(ctx context.Context) (int, error) {
	count, err := c.queries.CountPoolUsers(ctx)
	if err != nil {
		return 0, fmt.Errorf("count pool users: %w", err)
	}
	return int(count), nil
}

// CreatePoolUser creates a new pool user with placeholder data.
// Returns the user ID of the created pool user.
func (c *Client) CreatePoolUser(ctx context.Context) (string, error) {
	userID, err := c.queries.CreatePoolUser(ctx)
	if err != nil {
		return "", fmt.Errorf("create pool user: %w", err)
	}
	return userID, nil
}

// virtualKeyTTL is how long we cache the existence of a virtual key.
// DeleteVirtualKey invalidates the cache, so false-positives are short-lived.
// False-negatives (cache miss) just mean one extra DB query.
const virtualKeyTTL = 60 * time.Second

// HasVirtualKey checks if a user already has a virtual key stored.
// Results are cached in an LRU with TTL to avoid hammering the database
// on every reconciliation loop (this query accounts for ~78% of total DB time).
func (c *Client) HasVirtualKey(ctx context.Context, userID string) (bool, error) {
	if _, ok := c.virtualKeyCache.Get(userID); ok {
		return true, nil
	}

	exists, err := c.queries.HasVirtualKey(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("check virtual key: %w", err)
	}

	if exists {
		c.virtualKeyCache.Set(userID, struct{}{}, virtualKeyTTL)
	}

	return exists, nil
}

// InsertVirtualKey stores an encrypted LiteLLM virtual key for a user.
// Uses INSERT ... ON CONFLICT to handle both insert and update cases.
// Timestamps are managed by the database (created_at default, updated_at trigger).
func (c *Client) InsertVirtualKey(ctx context.Context, userID string, ciphertext []byte) error {
	err := c.queries.UpsertVirtualKey(ctx, &repo.UpsertVirtualKeyParams{
		UserID:     userID,
		Ciphertext: ciphertext,
	})
	if err != nil {
		c.logger.Error("Failed to insert virtual key",
			"error", err,
			"user_id", userID,
		)
		return fmt.Errorf("insert virtual key: %w", err)
	}

	c.virtualKeyCache.Set(userID, struct{}{}, virtualKeyTTL)
	return nil
}

// DeleteVirtualKey removes a user's virtual key from the database and invalidates the cache.
func (c *Client) DeleteVirtualKey(ctx context.Context, userID string) error {
	err := c.queries.DeleteVirtualKey(ctx, userID)
	if err != nil {
		c.logger.Error("Failed to delete virtual key",
			"error", err,
			"user_id", userID,
		)
		return fmt.Errorf("delete virtual key: %w", err)
	}

	c.virtualKeyCache.Delete(userID)
	return nil
}

// userFromFirstPageRow converts a GetUsersFirstPageRow to a User.
func userFromFirstPageRow(row *repo.GetUsersFirstPageRow) User {
	var bounceAuthUserID *string
	if row.BounceAuthUserID.Valid {
		bounceAuthUserID = &row.BounceAuthUserID.String
	}
	return User{
		ID:               row.ID,
		BounceAuthUserID: bounceAuthUserID,
		FullName:         &row.FullName,
		Email:            &row.Email,
		CreatedAt:        row.CreatedAt.Time,
		UpdatedAt:        row.UpdatedAt.Time,
		DisplayName:      &row.DisplayName,
		ProfilePhoto:     &row.ProfilePhoto,
	}
}

// userFromAfterCursorRow converts a GetUsersAfterCursorRow to a User.
func userFromAfterCursorRow(row *repo.GetUsersAfterCursorRow) User {
	var bounceAuthUserID *string
	if row.BounceAuthUserID.Valid {
		bounceAuthUserID = &row.BounceAuthUserID.String
	}
	return User{
		ID:               row.ID,
		BounceAuthUserID: bounceAuthUserID,
		FullName:         &row.FullName,
		Email:            &row.Email,
		CreatedAt:        row.CreatedAt.Time,
		UpdatedAt:        row.UpdatedAt.Time,
		DisplayName:      &row.DisplayName,
		ProfilePhoto:     &row.ProfilePhoto,
	}
}

// userFromByIDRow converts a GetUserByIDRow to a User.
func userFromByIDRow(row *repo.GetUserByIDRow) User {
	var bounceAuthUserID, fullName, email, displayName, profilePhoto *string

	if row.BounceAuthUserID.Valid {
		bounceAuthUserID = &row.BounceAuthUserID.String
	}
	fullName = &row.FullName
	email = &row.Email
	displayName = &row.DisplayName
	profilePhoto = &row.ProfilePhoto

	return User{
		ID:               row.ID,
		BounceAuthUserID: bounceAuthUserID,
		FullName:         fullName,
		Email:            email,
		CreatedAt:        row.CreatedAt.Time,
		UpdatedAt:        row.UpdatedAt.Time,
		DisplayName:      displayName,
		ProfilePhoto:     profilePhoto,
	}
}
