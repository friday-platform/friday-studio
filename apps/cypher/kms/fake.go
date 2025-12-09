package kms

import (
	"github.com/tink-crypto/tink-go/v2/core/registry"
	"github.com/tink-crypto/tink-go/v2/testing/fakekms"
	"github.com/tink-crypto/tink-go/v2/tink"
)

const fakeKeyURI = "fake-kms://CM2b3_MDElQKSAowdHlwZS5nb29nbGVhcGlzLmNvbS9nb29nbGUuY3J5cHRvLnRpbmsuQWVzR2NtS2V5EhIaEIK75t5L-adlUwVhWvRuWUwYARABGM2b3_MDIAE"

type FakeKMS struct {
	client registry.KMSClient
}

func NewFakeKMS() *FakeKMS {
	client, err := fakekms.NewClient(fakeKeyURI)
	if err != nil {
		panic(err)
	}

	return &FakeKMS{
		client: client,
	}
}

func (f *FakeKMS) GetAEADBackend() (tink.AEAD, error) {
	return f.client.GetAEAD(fakeKeyURI)
}

var _ KeyEncryptionService = (*FakeKMS)(nil)
