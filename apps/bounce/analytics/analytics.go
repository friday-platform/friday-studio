// Package analytics provides user metrics tracking for bounce service.
package analytics

import (
	"context"
	"fmt"
	golog "log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

const logType = "analytics"

var (
	provider     *sdklog.LoggerProvider
	providerOnce sync.Once
	disabled     bool
	environment  string
)

func getLogger() log.Logger {
	providerOnce.Do(func() {
		endpoint := os.Getenv("ANALYTICS_OTEL_ENDPOINT")
		if endpoint == "" {
			disabled = true
			return
		}

		environment = os.Getenv("ENVIRONMENT")
		if environment == "" {
			environment = "development"
		}

		exporter, err := otlploghttp.New(context.Background(),
			otlploghttp.WithEndpointURL(endpoint),
		)
		if err != nil {
			golog.Printf("analytics: failed to create OTEL exporter: %v (analytics disabled)", err)
			disabled = true
			return
		}

		provider = sdklog.NewLoggerProvider(
			sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
		)
	})

	if disabled || provider == nil {
		return nil
	}
	return provider.Logger("analytics")
}

// Emit sends an analytics event via OTEL logging.
// The log.type=analytics attribute triggers routing to BigQuery.
// No-op if ANALYTICS_OTEL_ENDPOINT is not set or userID is empty.
func Emit(ctx context.Context, eventName, userID string, attrs map[string]any) {
	if strings.TrimSpace(userID) == "" {
		golog.Printf("analytics: skipping event %q with empty userID", eventName)
		return
	}

	logger := getLogger()
	if logger == nil {
		return
	}

	record := log.Record{}
	record.SetTimestamp(time.Now())
	record.SetBody(log.StringValue(eventName))
	record.AddAttributes(
		log.String("log.type", logType),
		log.String("event_name", eventName),
		log.String("event_id", uuid.New().String()),
		log.String("user_id", userID),
		log.String("environment", environment),
	)

	for k, v := range attrs {
		switch val := v.(type) {
		case string:
			record.AddAttributes(log.String(k, val))
		case int:
			record.AddAttributes(log.Int(k, val))
		case int64:
			record.AddAttributes(log.Int64(k, val))
		case float64:
			record.AddAttributes(log.Float64(k, val))
		case bool:
			record.AddAttributes(log.Bool(k, val))
		default:
			// Stringify anything else
			record.AddAttributes(log.String(k, fmt.Sprintf("%v", v)))
		}
	}

	logger.Emit(ctx, record)
}

// Shutdown gracefully shuts down the analytics provider, flushing any buffered events.
// Should be called during service shutdown.
func Shutdown(ctx context.Context) error {
	if provider != nil {
		return provider.Shutdown(ctx)
	}
	return nil
}
