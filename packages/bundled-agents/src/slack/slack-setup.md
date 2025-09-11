# Slack Agent Authentication & Configuration Guide

This guide explains how to configure Slack authentication for the Atlas Slack agent and Slack MCP server, including token types, scopes, and secure storage recommendations. It is adapted from the Slack MCP server authentication setup reference.

## How to get Bot Token

1. Open slack Apps site [Slack Apps](https://api.slack.com/apps)
2. Click on "Create New App" and choose "From scratch" option.
3. Set App name and pick desired workspace.
4. Under Features → OAuth & Permissions:
   - Add bot scopes ("Bot Scopes" below).
   - Install the app to your workspace to generate a Bot User OAuth Token (xoxb-...).

## How to add App to a channel

1. Open desired channel
2. Open all members window
3. Go to "Integrations" tab
4. Click on "Add an App" button and find your app.

### Bot Scopes

Required permissions by slack agent. Can be limited to your use case if needed (not recommended).

- channels:history, channels:read
- chat:write
- groups:history, groups:read
- im:history, im:read, im:write
- mpim:history, mpim:read, mpim:write
- users:read
- search:read.users

Confirm scopes in Slack App → OAuth & Permissions before installation.

## Environment Variables

To enable Slack functionality, you need the app token with appropriate scopes.

Set tokens securely via environment variables. Atlas components and the Slack MCP server commonly read:

- SLACK_MCP_XOXP_TOKEN: Bot OAuth token (xoxb-...)

Store these in local `.env` in `~/.atlas` directory.

## Testing the Setup

1. Verify tokens are present in the environment: `echo $SLACK_MCP_XOXP_TOKEN`.
2. Run the agent and send a simple message to a test channel (ask user which channel is test one).
3. Check for permission errors; if present, ask user to revisit scopes and reinstall the app.

## Security Notes

- Rotate tokens periodically and revoke unused tokens in Slack App settings.
- Restrict scopes to the minimum necessary.
- Bot/App needs to be added to each channel separetely to be able to write/read from it. Make sure user added App integration before test.

## References

- Slack MCP Server Authentication Setup: [github.com/korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server/blob/master/docs/01-authentication-setup.md)
