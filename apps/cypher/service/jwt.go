package service

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/tempestteam/atlas/apps/cypher/repo"
)

// AtlasTokenClaims defines the JWT claims structure.
// Must match waypoint's CredentialTokenClaims for compatibility.
type AtlasTokenClaims struct {
	Email        string `json:"email,omitempty"`
	UserMetadata struct {
		TempestUserID string `json:"tempest_user_id"`
	} `json:"user_metadata"`
	jwt.RegisteredClaims
}

// generateJWT creates a signed JWT token for the user.
func generateJWT(privateKey *rsa.PrivateKey, user repo.GetUserByIDRow) (string, time.Time, error) {
	now := time.Now()
	expiresAt := now.Add(365 * 24 * time.Hour)

	// Use email as subject if available, otherwise use user ID
	subject := user.Email
	if subject == "" {
		subject = user.ID
	}

	claims := AtlasTokenClaims{
		Email: user.Email,
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        uuid.NewString(),
			Issuer:    "tempest-atlas",
			Audience:  jwt.ClaimStrings{"atlas"},
			Subject:   subject,
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			NotBefore: jwt.NewNumericDate(now),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}
	claims.UserMetadata.TempestUserID = user.ID

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(privateKey)
	if err != nil {
		return "", time.Time{}, err
	}

	return signed, expiresAt, nil
}

// ParsePrivateKey parses a PEM-encoded PKCS#8 RSA private key.
func ParsePrivateKey(pemData string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemData))
	if block == nil {
		return nil, errors.New("failed to decode PEM block")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an RSA private key")
	}
	return rsaKey, nil
}
