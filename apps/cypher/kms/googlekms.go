package kms

import (
	"context"

	"github.com/tink-crypto/tink-go-gcpkms/v2/integration/gcpkms"
	"github.com/tink-crypto/tink-go/v2/core/registry"
	"github.com/tink-crypto/tink-go/v2/tink"
)

type GoogleKMS struct {
	client registry.KMSClient
	keyURI string
}

// NewGoogleKMS creates a new GoogleKMS with the given key URI.
// keyURI format: gcp-kms://projects/PROJECT_ID/locations/LOCATION/keyRings/KEY_RING/cryptoKeys/KEY
//
// In GKE with Workload Identity, credentials are automatically provided.
// For local development, set GOOGLE_APPLICATION_CREDENTIALS environment variable.
func NewGoogleKMS(ctx context.Context, keyURI string) (*GoogleKMS, error) {
	client, err := gcpkms.NewClientWithOptions(ctx, keyURI)
	if err != nil {
		return nil, err
	}

	return &GoogleKMS{
		client: client,
		keyURI: keyURI,
	}, nil
}

func (g *GoogleKMS) GetAEADBackend() (tink.AEAD, error) {
	return g.client.GetAEAD(g.keyURI)
}

var _ KeyEncryptionService = (*GoogleKMS)(nil)
