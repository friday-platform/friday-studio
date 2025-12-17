package service

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics for cypher service.
var (
	// EncryptTotal counts encryption operations by result.
	EncryptTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cypher_encrypt_total",
			Help: "Total encryption operations",
		},
		[]string{"result"},
	)

	// DecryptTotal counts decryption operations by result.
	DecryptTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cypher_decrypt_total",
			Help: "Total decryption operations",
		},
		[]string{"result"},
	)

	// KeyCacheHits counts key cache hits.
	KeyCacheHits = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "cypher_key_cache_hits_total",
			Help: "Total key cache hits",
		},
	)

	// KeyCacheMisses counts key cache misses.
	KeyCacheMisses = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "cypher_key_cache_misses_total",
			Help: "Total key cache misses",
		},
	)

	// KeysCreated counts new keys created.
	KeysCreated = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "cypher_keys_created_total",
			Help: "Total encryption keys created",
		},
	)

	// InternalEncryptTotal counts internal encryption operations by result.
	InternalEncryptTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cypher_internal_encrypt_total",
			Help: "Total internal encryption operations (from atlas-operator)",
		},
		[]string{"result"},
	)

	// TokenIssuedTotal counts token issuance operations by result.
	TokenIssuedTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cypher_token_issued_total",
			Help: "Total pod token issuance operations",
		},
		[]string{"result"},
	)

	// CredentialsTotal counts credentials fetch operations by result.
	CredentialsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cypher_credentials_total",
			Help: "Total credentials fetch operations",
		},
		[]string{"result"},
	)
)

// RecordEncrypt records an encryption operation result.
// result: "success" or "failure".
func RecordEncrypt(result string) {
	EncryptTotal.WithLabelValues(result).Inc()
}

// RecordDecrypt records a decryption operation result.
// result: "success" or "failure".
func RecordDecrypt(result string) {
	DecryptTotal.WithLabelValues(result).Inc()
}

// RecordCacheHit records a key cache hit.
func RecordCacheHit() {
	KeyCacheHits.Inc()
}

// RecordCacheMiss records a key cache miss.
func RecordCacheMiss() {
	KeyCacheMisses.Inc()
}

// RecordKeyCreated records a new key creation.
func RecordKeyCreated() {
	KeysCreated.Inc()
}

// RecordInternalEncrypt records an internal encryption operation result.
func RecordInternalEncrypt(result string) {
	InternalEncryptTotal.WithLabelValues(result).Inc()
}

// RecordTokenIssued records a token issuance operation result.
func RecordTokenIssued(result string) {
	TokenIssuedTotal.WithLabelValues(result).Inc()
}

// RecordCredentials records a credentials fetch operation result.
func RecordCredentials(result string) {
	CredentialsTotal.WithLabelValues(result).Inc()
}
