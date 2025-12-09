package kms

import "github.com/tink-crypto/tink-go/v2/tink"

type KeyEncryptionService interface {
	GetAEADBackend() (tink.AEAD, error)
}
