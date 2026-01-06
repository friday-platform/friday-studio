package main

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// AtlasTokenClaims matches cypher's JWT claims structure.
type AtlasTokenClaims struct {
	Email        string `json:"email,omitempty"`
	UserMetadata struct {
		TempestUserID string `json:"tempest_user_id"`
	} `json:"user_metadata"`
	jwt.RegisteredClaims
}

func parsePrivateKey(pemData string) (*rsa.PrivateKey, error) {
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

func generateJWT(privateKey *rsa.PrivateKey, userID, email string) (string, time.Time, error) {
	now := time.Now()
	expiresAt := now.Add(24 * time.Hour)

	subject := userID
	if email != "" {
		subject = email
	}

	claims := AtlasTokenClaims{
		Email: email,
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
	claims.UserMetadata.TempestUserID = userID

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(privateKey)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, expiresAt, nil
}
