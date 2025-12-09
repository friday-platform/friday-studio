package kms

import (
	"testing"
)

func TestFakeKMS_GetAEADBackend(t *testing.T) {
	kms := NewFakeKMS()

	aead, err := kms.GetAEADBackend()
	if err != nil {
		t.Fatalf("GetAEADBackend() error = %v", err)
	}

	if aead == nil {
		t.Fatal("GetAEADBackend() returned nil AEAD")
	}
}

func TestFakeKMS_EncryptDecrypt(t *testing.T) {
	kms := NewFakeKMS()

	aead, err := kms.GetAEADBackend()
	if err != nil {
		t.Fatalf("GetAEADBackend() error = %v", err)
	}

	plaintext := []byte("hello world")
	aad := []byte("user-123")

	ciphertext, err := aead.Encrypt(plaintext, aad)
	if err != nil {
		t.Fatalf("Encrypt() error = %v", err)
	}

	if len(ciphertext) == 0 {
		t.Fatal("Encrypt() returned empty ciphertext")
	}

	decrypted, err := aead.Decrypt(ciphertext, aad)
	if err != nil {
		t.Fatalf("Decrypt() error = %v", err)
	}

	if string(decrypted) != string(plaintext) {
		t.Errorf("Decrypt() = %q, want %q", decrypted, plaintext)
	}
}

func TestFakeKMS_DecryptWithWrongAAD(t *testing.T) {
	kms := NewFakeKMS()

	aead, err := kms.GetAEADBackend()
	if err != nil {
		t.Fatalf("GetAEADBackend() error = %v", err)
	}

	plaintext := []byte("secret data")
	aad := []byte("user-123")
	wrongAAD := []byte("user-456")

	ciphertext, err := aead.Encrypt(plaintext, aad)
	if err != nil {
		t.Fatalf("Encrypt() error = %v", err)
	}

	_, err = aead.Decrypt(ciphertext, wrongAAD)
	if err == nil {
		t.Fatal("Decrypt() with wrong AAD should fail")
	}
}

func TestFakeKMS_ImplementsInterface(t *testing.T) {
	var _ KeyEncryptionService = (*FakeKMS)(nil)
}
