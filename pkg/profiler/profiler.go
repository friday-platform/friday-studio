// Package profiler provides Google Cloud Profiler integration.
package profiler

import (
	"log/slog"

	cloudprofiler "cloud.google.com/go/profiler"
)

// Config holds profiler configuration.
type Config struct {
	Enabled bool `env:"PROFILER_ENABLED" envDefault:"false"`
}

// Start initializes the Cloud Profiler if enabled.
// Parameters:
//   - cfg: Profiler configuration from environment
//   - service: Service name for profiler identification
//   - version: Version string, typically GitCommit from ldflags
//   - logger: Optional logger for status messages (can be nil)
func Start(cfg Config, service, version string, logger *slog.Logger) error {
	if !cfg.Enabled {
		return nil
	}

	if err := cloudprofiler.Start(cloudprofiler.Config{
		Service:        service,
		ServiceVersion: version,
		AllocForceGC:   true,
	}); err != nil {
		return err
	}

	if logger != nil {
		logger.Info("Cloud Profiler started", "service", service, "version", version)
	}

	return nil
}
