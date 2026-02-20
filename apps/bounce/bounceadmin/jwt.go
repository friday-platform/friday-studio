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

// AMREntry matches bounce's service.AMREntry.
type AMREntry struct {
	Method    string `json:"method"`
	Timestamp int64  `json:"timestamp"`
	Provider  string `json:"provider,omitempty"`
}

// SessionClaims matches bounce's service.Claims exactly.
type SessionClaims struct {
	jwt.RegisteredClaims
	Email        string         `json:"email"`
	UserMetadata map[string]any `json:"user_metadata"`
	Role         string         `json:"role"`
	AAL          string         `json:"aal,omitempty"`
	AMR          []AMREntry     `json:"amr,omitempty"`
	SessionId    string         `json:"session_id,omitempty"`
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

func generateSessionJWT(privateKey *rsa.PrivateKey, userID, authUserID, email string) (string, time.Time, error) {
	now := time.Now()
	expiresAt := now.Add(24 * time.Hour)
	sessionID := uuid.NewString()

	claims := SessionClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Audience:  jwt.ClaimStrings{"atlas"},
			Subject:   userID,
			NotBefore: jwt.NewNumericDate(now),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			ID:        sessionID,
		},
		Email: email,
		UserMetadata: map[string]any{
			"tempest_user_id":      userID,
			"tempest_auth_user_id": authUserID,
		},
		Role:      "authenticated",
		SessionId: sessionID,
		AMR: []AMREntry{
			{
				Method:    "admin",
				Timestamp: now.Unix(),
				Provider:  "bounceadmin",
			},
		},
		AAL: "AAL1",
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(privateKey)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, expiresAt, nil
}
