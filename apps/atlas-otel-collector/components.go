package main

import (
	"github.com/open-telemetry/opentelemetry-collector-contrib/exporter/googlecloudexporter"
	"github.com/open-telemetry/opentelemetry-collector-contrib/exporter/prometheusexporter"
	"github.com/open-telemetry/opentelemetry-collector-contrib/extension/healthcheckextension"
	"github.com/open-telemetry/opentelemetry-collector-contrib/processor/filterprocessor"
	"github.com/open-telemetry/opentelemetry-collector-contrib/processor/resourceprocessor"
	"github.com/open-telemetry/opentelemetry-collector-contrib/processor/transformprocessor"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/exporter/otlpexporter"
	"go.opentelemetry.io/collector/exporter/otlphttpexporter"
	"go.opentelemetry.io/collector/extension"
	"go.opentelemetry.io/collector/extension/zpagesextension"
	"go.opentelemetry.io/collector/otelcol"
	"go.opentelemetry.io/collector/processor"
	"go.opentelemetry.io/collector/processor/batchprocessor"
	"go.opentelemetry.io/collector/receiver"
	"go.opentelemetry.io/collector/receiver/otlpreceiver"
)

func components() (otelcol.Factories, error) {
	var err error
	factories := otelcol.Factories{}

	factories.Receivers, err = otelcol.MakeFactoryMap[receiver.Factory](
		otlpreceiver.NewFactory(),
	)
	if err != nil {
		return otelcol.Factories{}, err
	}

	factories.Exporters, err = otelcol.MakeFactoryMap[exporter.Factory](
		otlpexporter.NewFactory(),
		otlphttpexporter.NewFactory(),
		googlecloudexporter.NewFactory(),
		prometheusexporter.NewFactory(),
		NewFactory(),
	)
	if err != nil {
		return otelcol.Factories{}, err
	}

	factories.Processors, err = otelcol.MakeFactoryMap[processor.Factory](
		batchprocessor.NewFactory(),
		filterprocessor.NewFactory(),
		transformprocessor.NewFactory(),
		resourceprocessor.NewFactory(),
	)
	if err != nil {
		return otelcol.Factories{}, err
	}

	factories.Extensions, err = otelcol.MakeFactoryMap[extension.Factory](
		zpagesextension.NewFactory(),
		healthcheckextension.NewFactory(),
	)

	return factories, err
}
