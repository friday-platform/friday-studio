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
