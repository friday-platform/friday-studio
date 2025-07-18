# @atlas/notifications

Notification provider system for Atlas workspaces. Provides a generic notification interface with
support for multiple providers including SendGrid for email, Slack, Discord, and Microsoft Teams.

## Features

- **Generic Interface**: Unified notification interface for all providers
- **Multiple Providers**: SendGrid, Slack, Discord, Microsoft Teams
- **Type Safety**: Full TypeScript support with Zod validation
- **Error Handling**: Comprehensive error handling with retry logic
- **Configuration**: YAML-based configuration with environment variable support
- **Extensible**: Easy to add new notification providers

## Supported Providers

- **SendGrid**: Email notifications via SendGrid API
- **Slack**: Slack channel notifications via webhooks
- **Discord**: Discord channel notifications via webhooks
- **Microsoft Teams**: Teams channel notifications via webhooks

## Usage

```typescript
import { NotificationManager, SendGridProvider } from "@atlas/notifications";

// Create notification manager
const manager = new NotificationManager({
  providers: {
    sendgrid: new SendGridProvider({
      apiKey: process.env.SENDGRID_API_KEY,
      fromEmail: "notifications@example.com",
    }),
  },
});

// Send email notification
await manager.sendEmail({
  provider: "sendgrid",
  to: "user@example.com",
  subject: "Test Notification",
  content: "This is a test notification from Atlas",
});
```

## Configuration

Add notification configuration to your `workspace.yml`:

```yaml
notifications:
  providers:
    sendgrid:
      provider: "sendgrid"
      enabled: true
      config:
        api_key_env: "SENDGRID_API_KEY"
        from_email: "notifications@example.com"
        from_name: "Atlas Notifications"

    slack:
      provider: "slack"
      enabled: true
      config:
        webhook_url_env: "SLACK_WEBHOOK_URL"
        channel: "#alerts"

  defaults:
    provider: "sendgrid"
    retry_attempts: 3
    retry_delay: "5s"
```

## Environment Variables

Set the following environment variables:

```bash
# SendGrid
SENDGRID_API_KEY=your_sendgrid_api_key

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Discord
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Microsoft Teams
TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/...
```
