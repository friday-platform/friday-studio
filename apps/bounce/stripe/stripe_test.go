package stripe

import (
	"os"
	"strings"
	"testing"
)

func TestCreateCustomer_Integration(t *testing.T) {
	apiKey := os.Getenv("STRIPE_TEST_SECRET_KEY")
	if apiKey == "" {
		t.Skip("STRIPE_TEST_SECRET_KEY not set, skipping integration test")
	}

	customerID, err := CreateCustomer(apiKey, "test-user-123", "test@example.com", "Test User")
	if err != nil {
		t.Fatalf("Failed to create customer: %v", err)
	}

	if !strings.HasPrefix(customerID, "cus_") {
		t.Errorf("Expected customer ID to start with 'cus_', got: %s", customerID)
	}

	t.Logf("Created Stripe customer: %s", customerID)
}
