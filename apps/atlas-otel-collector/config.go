package main

import (
	"errors"

	"go.opentelemetry.io/collector/config/configretry"
)

// Config defines configuration for the BigQuery exporter.
type Config struct {
	// ProjectID is the GCP project ID.
	ProjectID string `mapstructure:"project_id"`

	// DatasetID is the BigQuery dataset ID.
	DatasetID string `mapstructure:"dataset_id"`

	// TableID is the BigQuery table ID.
	TableID string `mapstructure:"table_id"`

	// RetryConfig defines retry behavior for failed inserts.
	configretry.BackOffConfig `mapstructure:"retry_on_failure"`
}

// Validate checks if the configuration is valid.
func (cfg *Config) Validate() error {
	if cfg.ProjectID == "" {
		return errors.New("project_id is required")
	}
	if cfg.DatasetID == "" {
		return errors.New("dataset_id is required")
	}
	if cfg.TableID == "" {
		return errors.New("table_id is required")
	}
	return nil
}
