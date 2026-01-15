package main

import (
	"context"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/config/configretry"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
)

const (
	typeStr   = "bigquery"
	stability = component.StabilityLevelAlpha
)

// NewFactory creates a factory for the BigQuery exporter.
func NewFactory() exporter.Factory {
	return exporter.NewFactory(
		component.MustNewType(typeStr),
		createDefaultConfig,
		exporter.WithLogs(createLogsExporter, stability),
	)
}

func createDefaultConfig() component.Config {
	return &Config{
		BackOffConfig: configretry.NewDefaultBackOffConfig(),
	}
}

func createLogsExporter(
	ctx context.Context,
	set exporter.Settings,
	cfg component.Config,
) (exporter.Logs, error) {
	c := cfg.(*Config)

	exp := newBigQueryExporter(c, set.Logger)

	return exporterhelper.NewLogs(
		ctx,
		set,
		cfg,
		exp.pushLogs,
		exporterhelper.WithStart(exp.start),
		exporterhelper.WithShutdown(exp.shutdown),
		exporterhelper.WithRetry(c.BackOffConfig),
	)
}
