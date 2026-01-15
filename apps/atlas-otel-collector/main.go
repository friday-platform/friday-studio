package main

import (
	"log"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/confmap"
	envprovider "go.opentelemetry.io/collector/confmap/provider/envprovider"
	fileprovider "go.opentelemetry.io/collector/confmap/provider/fileprovider"
	"go.opentelemetry.io/collector/otelcol"
)

func main() {
	info := component.BuildInfo{
		Command:     "atlas-otel-collector",
		Description: "Atlas OpenTelemetry Collector with BigQuery exporter",
		Version:     "0.1.0",
	}

	set := otelcol.CollectorSettings{
		BuildInfo: info,
		Factories: components,
		ConfigProviderSettings: otelcol.ConfigProviderSettings{
			ResolverSettings: confmap.ResolverSettings{
				ProviderFactories: []confmap.ProviderFactory{
					envprovider.NewFactory(),
					fileprovider.NewFactory(),
				},
			},
		},
	}

	cmd := otelcol.NewCommand(set)
	if err := cmd.Execute(); err != nil {
		log.Fatal(err)
	}
}
