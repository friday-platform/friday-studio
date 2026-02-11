package service

import (
	"fmt"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	sendGridRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gateway_sendgrid_requests_total",
			Help: "Total SendGrid proxy requests",
		},
		[]string{"status"},
	)

	parallelRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gateway_parallel_requests_total",
			Help: "Total Parallel proxy requests",
		},
		[]string{"status"},
	)

	emailSuppressionsTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "gateway_email_suppressions_total",
			Help: "Total emails suppressed (recipient unsubscribed)",
		},
	)

	unsubscribeRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gateway_unsubscribe_requests_total",
			Help: "Total unsubscribe requests",
		},
		[]string{"method", "status"},
	)
)

func recordSendGridRequest(status int) {
	sendGridRequestsTotal.WithLabelValues(fmt.Sprintf("%d", status)).Inc()
}

func recordParallelRequest(status int) {
	parallelRequestsTotal.WithLabelValues(fmt.Sprintf("%d", status)).Inc()
}
