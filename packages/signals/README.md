# @atlas/signals

Atlas signal providers and registry system.

## Overview

This package provides signal providers for Atlas:

- **Signal Providers**: Built-in providers for HTTP, webhooks, timers, streams, and Kubernetes
  events
- **Provider Registry**: Factory system for provider creation and management
- **Runtime Integration**: Providers integrate with workspace runtime for signal generation

## Architecture

### Signal Providers

Signal providers generate signals from various sources:

- **HTTP Signal**: REST endpoint triggers
- **HTTP Webhook**: Webhook handlers with validation
- **Timer Signal**: Cron-based scheduled triggers
- **Stream Signal**: Real-time stream processing
- **Kubernetes Events**: K8s event monitoring
- **Kubernetes Auth**: K8s authentication handling

### Provider Registry

Centralized factory system that:

- Registers provider factories
- Creates provider instances from configuration
- Manages provider lifecycle

### Runtime Integration

Providers are loaded by the workspace runtime through the registry and generate signals that trigger
jobs and workflows.

## Usage

### Using the Provider Registry

```typescript
import { ProviderRegistry } from "@atlas/signals";

// Register built-in providers
ProviderRegistry.registerBuiltinProviders();

// Get registry instance
const registry = ProviderRegistry.getInstance();

// Create provider from configuration
const config = {
  id: "my-signal",
  provider: "http",
  config: {
    path: "/webhook",
    method: "POST",
  },
};

const provider = await registry.loadFromConfig(config);
await provider.setup();
```

### Using Individual Providers

```typescript
import { HTTPSignalProvider, TimerSignalProvider } from "@atlas/signals";

// Create HTTP signal provider
const httpProvider = new HTTPSignalProvider({
  id: "api-webhook",
  description: "API webhook handler",
  provider: "http",
  path: "/api/webhook",
  method: "POST",
});

// Create timer signal provider
const timerProvider = new TimerSignalProvider({
  id: "daily-report",
  description: "Daily report generator",
  provider: "timer",
  schedule: "0 9 * * *", // 9 AM daily
});
```

## Provider Types

Each provider implements the `ISignalProvider` interface and can be configured through the registry
or instantiated directly.

### Available Providers

- `HTTPSignalProvider` - HTTP endpoint signals
- `HttpWebhookProvider` - Webhook handlers
- `TimerSignalProvider` - Scheduled signals
- `StreamSignalProvider` - Real-time stream signals
- `K8sEventsSignalProvider` - Kubernetes event signals
- `K8sAuthManager` - Kubernetes authentication

## Testing

Run tests with:

```bash
deno test --allow-all
```

## Dependencies

- `zod` - Schema validation
- `hono` - HTTP handling
- `cron-parser` - Cron parsing
- Atlas utilities (logger, telemetry)
