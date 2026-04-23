# Messaging signal providers

Slack, Telegram, and WhatsApp are full messaging providers with runtime
adapters. All three support env-var credential fallbacks — populate either
the inline `config:` block or the listed env vars.

## Slack

```yaml
signals:
  slack-msg:
    provider: slack
    description: "Slack app event"
    config:
      app_id: ""                # populated by auto-wire during workspace_create
```

Slack apps are auto-wired from a credential registered in the link service
during workspace creation. Don't hand-edit `app_id`.

## Telegram

```yaml
signals:
  tg:
    provider: telegram
    description: "Telegram update"
    config:
      bot_token: ""             # env TELEGRAM_BOT_TOKEN
      webhook_secret: ""        # env TELEGRAM_WEBHOOK_SECRET
```

Bot token is the `<bot-id>:<secret>` pair from BotFather. `webhook_secret` is
any 32+ char string you generate; Telegram sends it back in the
`X-Telegram-Bot-Api-Secret-Token` header on every webhook.

## WhatsApp

```yaml
signals:
  wa:
    provider: whatsapp
    description: "WhatsApp message"
    config:
      access_token: ""          # env WHATSAPP_ACCESS_TOKEN
      app_secret: ""            # env WHATSAPP_APP_SECRET
      phone_number_id: ""       # env WHATSAPP_PHONE_NUMBER_ID
      verify_token: ""          # env WHATSAPP_VERIFY_TOKEN
      api_version: "v21.0"      # optional
```

Meta access tokens rotate every 24h unless you use a System User token —
prefer System User tokens for anything long-running. The webhook
verify/challenge flow uses `verify_token`.
