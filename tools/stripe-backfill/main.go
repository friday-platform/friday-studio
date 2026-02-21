// stripe-backfill creates Stripe customers for users who were created without one.
//
// Usage:
//
//	POSTGRES_CONNECTION=<dsn> STRIPE_SECRET_KEY=<key> go run ./tools/stripe-backfill [--dry-run]
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	bouncerepo "github.com/tempestteam/atlas/apps/bounce/repo"
	"github.com/tempestteam/atlas/apps/bounce/stripe"
)

const usersWithoutStripeQuery = `
SELECT id, bounce_auth_user_id, full_name, email, created_at, updated_at,
       display_name, profile_photo, pool_available, name, stripe_customer_id
FROM public."user"
WHERE stripe_customer_id IS NULL AND pool_available = false
ORDER BY created_at ASC
`

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	dryRun := flag.Bool("dry-run", false, "Print affected users without making changes")
	flag.Parse()

	pgConn := os.Getenv("POSTGRES_CONNECTION")
	if pgConn == "" {
		return fmt.Errorf("POSTGRES_CONNECTION env var is required")
	}

	stripeKey := os.Getenv("STRIPE_SECRET_KEY")
	if stripeKey == "" && !*dryRun {
		return fmt.Errorf("STRIPE_SECRET_KEY env var is required (or use --dry-run)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool, err := pgxpool.New(ctx, pgConn)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer pool.Close()

	rows, err := pool.Query(ctx, usersWithoutStripeQuery)
	if err != nil {
		return fmt.Errorf("failed to query users: %w", err)
	}
	defer rows.Close()

	var users []bouncerepo.User
	for rows.Next() {
		var u bouncerepo.User
		if err := rows.Scan(
			&u.ID, &u.BounceAuthUserID, &u.FullName, &u.Email,
			&u.CreatedAt, &u.UpdatedAt, &u.DisplayName, &u.ProfilePhoto,
			&u.PoolAvailable, &u.Name, &u.StripeCustomerID,
		); err != nil {
			return fmt.Errorf("failed to scan user row: %w", err)
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("row iteration error: %w", err)
	}

	fmt.Printf("Found %d users without Stripe customer ID\n", len(users))

	if len(users) == 0 {
		return nil
	}

	for _, u := range users {
		fmt.Printf("  user_id=%s email=%s full_name=%s created_at=%s\n",
			u.ID, u.Email, u.FullName, u.CreatedAt.Time.Format(time.RFC3339))
	}

	if *dryRun {
		fmt.Println("\n--dry-run: no changes made")
		return nil
	}

	fmt.Println("\nCreating Stripe customers...")

	repo := bouncerepo.New(pool)
	var succeeded, failed int

	for _, u := range users {
		customerID, err := stripe.CreateCustomer(stripeKey, u.ID, u.Email, u.FullName)
		if err != nil {
			log.Printf("FAIL user_id=%s email=%s: %v", u.ID, u.Email, err)
			failed++
			continue
		}

		err = repo.UpdateUserStripeCustomerID(ctx, &bouncerepo.UpdateUserStripeCustomerIDParams{
			ID:               u.ID,
			StripeCustomerID: pgtype.Text{String: customerID, Valid: true},
		})
		if err != nil {
			log.Printf("FAIL user_id=%s: Stripe customer created (%s) but DB update failed: %v", u.ID, customerID, err) //nolint:gosec // G706: trusted internal data, not user input
			failed++
			continue
		}

		fmt.Printf("  OK user_id=%s stripe_customer_id=%s\n", u.ID, customerID)
		succeeded++
	}

	fmt.Printf("\nDone: %d succeeded, %d failed out of %d total\n", succeeded, failed, len(users))
	if failed > 0 {
		return fmt.Errorf("%d of %d users failed", failed, len(users))
	}

	return nil
}
