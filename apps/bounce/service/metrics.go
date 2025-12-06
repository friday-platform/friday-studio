package service

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics for bounce service.
var (
	// AuthTotal counts authentication attempts by type and result.
	AuthTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "bounce_auth_total",
			Help: "Total authentication attempts",
		},
		[]string{"type", "result"},
	)

	// EmailsSentTotal counts emails sent by type.
	EmailsSentTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "bounce_emails_sent_total",
			Help: "Total emails sent",
		},
		[]string{"type"},
	)
)

// RecordAuth records an authentication attempt.
// authType: "email", "magiclink", "google_oauth".
// result: "success", "failure".
func RecordAuth(authType, result string) {
	AuthTotal.WithLabelValues(authType, result).Inc()
}

// RecordEmailSent records an email being sent.
// emailType: "signup", "magiclink".
func RecordEmailSent(emailType string) {
	EmailsSentTotal.WithLabelValues(emailType).Inc()
}
