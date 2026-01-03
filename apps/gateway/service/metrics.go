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
)

func recordSendGridRequest(status int) {
	sendGridRequestsTotal.WithLabelValues(fmt.Sprintf("%d", status)).Inc()
}

func recordParallelRequest(status int) {
	parallelRequestsTotal.WithLabelValues(fmt.Sprintf("%d", status)).Inc()
}
