package service

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Metrics for gist service.
var (
	// UploadsTotal counts upload attempts by status.
	UploadsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gist_uploads_total",
			Help: "Total upload attempts",
		},
		[]string{"status"},
	)

	// DownloadsTotal counts download attempts by status.
	DownloadsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gist_downloads_total",
			Help: "Total download attempts",
		},
		[]string{"status"},
	)

	// UploadDurationSeconds tracks upload request duration.
	UploadDurationSeconds = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "gist_upload_duration_seconds",
			Help:    "Upload request duration in seconds",
			Buckets: prometheus.DefBuckets,
		},
	)
)

// RecordUpload records an upload attempt.
func RecordUpload(status string) {
	UploadsTotal.WithLabelValues(status).Inc()
}

// RecordUploadDuration records the duration of an upload request.
func RecordUploadDuration(duration time.Duration) {
	UploadDurationSeconds.Observe(duration.Seconds())
}

// RecordDownload records a download attempt.
func RecordDownload(status string) {
	DownloadsTotal.WithLabelValues(status).Inc()
}
