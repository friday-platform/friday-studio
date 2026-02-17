package database

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
	pool    *pgxpool.Pool
	queries *repo.Queries
	logger  *slog.Logger
}

// NewClient creates a new database client.
func NewClient(databaseURL string, logger *slog.Logger) (*Client, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database URL: %w", err)
	}

	config.MaxConns = 10
	config.MinConns = 2
	config.MaxConnLifetime = 5 * time.Minute
	config.MaxConnIdleTime = 3 * time.Minute

	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		return nil, fmt.Errorf("create connection pool: %w", err)
	}

	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	logger.Info("Connected to database",
		"max_conns", config.MaxConns,
	)

	return &Client{
		pool:    pool,
		queries: repo.New(pool),
		logger:  logger,
	}, nil
}

// GetUsers retrieves users from the database with cursor-based pagination.
// Use afterID="" for the first page. Returns up to limit users ordered by id.
func (c *Client) GetUsers(ctx context.Context, limit int, afterID string) ([]User, error) {
	l := clampToInt32(limit, 0, 10000)

	// Use separate queries to avoid OR that defeats index usage.
	if afterID == "" {
		return c.getUsersFirstPage(ctx, l)
	}
	return c.getUsersAfterCursor(ctx, l, afterID)
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

// GetUserIDsMissingVirtualKeys returns user IDs that don't have a virtual key yet.
// Uses a LEFT JOIN to compute the diff in a single query instead of per-user checks.
func (c *Client) GetUserIDsMissingVirtualKeys(ctx context.Context, limit int) ([]string, error) {
	ids, err := c.queries.GetUserIDsMissingVirtualKeys(ctx, clampToInt32(limit, 0, math.MaxInt32))
	if err != nil {
		c.logger.Error("Failed to get users missing virtual keys", "error", err)
		return nil, fmt.Errorf("get users missing virtual keys: %w", err)
	}
	return ids, nil
}

// GetVirtualKeyUserIDs returns which of the given user IDs have a virtual key stored.
func (c *Client) GetVirtualKeyUserIDs(ctx context.Context, userIDs []string) ([]string, error) {
	ids, err := c.queries.GetVirtualKeyUserIDs(ctx, userIDs)
	if err != nil {
		c.logger.Error("Failed to get virtual key user IDs", "error", err)
		return nil, fmt.Errorf("get virtual key user IDs: %w", err)
	}
	return ids, nil
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
	return nil
}

// DeleteVirtualKey removes a user's virtual key from the database.
func (c *Client) DeleteVirtualKey(ctx context.Context, userID string) error {
	err := c.queries.DeleteVirtualKey(ctx, userID)
	if err != nil {
		c.logger.Error("Failed to delete virtual key",
			"error", err,
			"user_id", userID,
		)
		return fmt.Errorf("delete virtual key: %w", err)
	}
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

// clampToInt32 clamps v to [lo, hi] and returns the result as int32.
func clampToInt32(v, lo, hi int) int32 {
	if v < lo {
		v = lo
	}
	if v > hi {
		v = hi
	}
	if v < math.MinInt32 {
		return math.MinInt32
	}
	if v > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(v)
}
