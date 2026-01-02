// Package stripe provides Stripe customer creation for user signup.
package stripe

import (
	"fmt"

	"github.com/stripe/stripe-go/v84"
	"github.com/stripe/stripe-go/v84/customer"
)

// CreateCustomer creates a new Stripe customer and returns the customer ID.
func CreateCustomer(secretKey, userID, email, name string) (string, error) {
	stripe.Key = secretKey

	params := &stripe.CustomerParams{
		Name:  stripe.String(name),
		Email: stripe.String(email),
		Metadata: map[string]string{
			"atlas_user_id": userID,
		},
	}
	// Idempotency key ensures retries don't create duplicate customers (valid 24h)
	params.SetIdempotencyKey("atlas-customer-" + userID)

	created, err := customer.New(params)
	if err != nil {
		return "", fmt.Errorf("failed to create Stripe customer: %w", err)
	}

	return created.ID, nil
}
