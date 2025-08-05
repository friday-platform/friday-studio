# Slack Feedback Summarizer

An Atlas workspace that automatically collects, analyzes, and summarizes user feedback from Slack
channels.

## Overview

This workspace monitors a designated Slack channel for user feedback, performs intelligent analysis
to categorize and prioritize the feedback, and posts comprehensive daily summaries. It's designed to
help teams stay on top of user feedback without manually reviewing every message.

## Features

- **Automated Collection**: Retrieves all messages from the feedback channel for the last 48 hours
- **Intelligent Analysis**: Categorizes feedback into bug reports, feature requests, and general
  feedback
- **Sentiment Analysis**: Identifies positive, negative, neutral, and critical feedback
- **Trend Detection**: Highlights patterns and recurring themes across feedback
- **Actionable Insights**: Provides prioritized recommendations with startup-appropriate timelines
- **Daily Summaries**: Posts formatted summaries with rich details and context

## Prerequisites

1. **Slack User Token**: The korotovsky/slack-mcp-server requires a user OAuth token (xoxp-) with
   the following scopes:
   - `channels:read` - To list and access public channels
   - `channels:history` - To read channel messages
   - `chat:write` - To post summary messages
   - `groups:read` - To access private channels if needed

2. **Atlas**: Ensure Atlas is installed and the daemon is running

## Configuration

### 1. Get a Slack User Token

The korotovsky/slack-mcp-server requires a user OAuth token (not a bot token). To get one:

1. Go to https://api.slack.com/apps
2. Create a new app or use an existing one
3. Go to "OAuth & Permissions"
4. Under "User Token Scopes", add:
   - `channels:read`
   - `channels:history`
   - `chat:write`
   - `groups:read` (if using private channels)
5. Install the app to your workspace
6. Copy the "User OAuth Token" (starts with `xoxp-`)

### 2. Update Environment Variables

Edit the workspace.yml file and replace the Slack token:

```yaml
env:
  SLACK_MCP_XOXP_TOKEN: "xoxp-YOUR-SLACK-USER-TOKEN-HERE"
```

### 3. Find Your Channel IDs

To find Slack channel IDs:

1. Right-click on the channel name in Slack
2. Select "View channel details"
3. Scroll to the bottom - the Channel ID is shown there
4. It will look like: C0123ABCDEF

### 4. Configure Channel IDs

Update these placeholders in workspace.yml:

- `YOUR-FEEDBACK-CHANNEL-ID`: The channel where feedback is collected (e.g., #feedback)
- `YOUR-SUMMARY-CHANNEL-ID`: The channel where summaries are posted (typically the same channel)

Note: It's recommended to post summaries to the same channel where feedback is collected, so
everyone who provides feedback can see the summary.

### 5. Adjust Schedule (Optional)

The workspace is configured to run daily at 9pm. To change this, modify the cron expression:

```yaml
signals:
  daily-summary:
    config:
      schedule: "0 21 * * *" # 9pm every day
      timezone: "America/Los_Angeles"
```

## Installation

1. Clone or copy this workspace to your local machine
2. Update the configuration as described above
3. Add the workspace to Atlas:

```bash
atlas workspace add /path/to/slack-feedback
```

## Usage

### Manual Trigger

Test the workspace with a manual trigger:

```bash
atlas signal trigger manual-summary --workspace slack-feedback-summarizer --data '{}'
```

### Automatic Daily Summaries

The workspace will automatically run at the scheduled time (default: 9pm daily) and post summaries
to the configured channel.

## Architecture

The workspace uses three specialized agents:

1. **feedback-collector**: Retrieves messages from Slack using the MCP server
2. **feedback-analyzer**: Analyzes and categorizes the collected feedback
3. **summary-generator**: Creates comprehensive summaries and posts them back to Slack

## Summary Format

The generated summaries include:

- **Overview**: Total items, contributors, sentiment breakdown
- **Critical Issues**: Urgent problems requiring immediate attention
- **Feature Requests**: Prioritized list with user context
- **Bug Reports**: Detailed descriptions with reproduction steps
- **Positive Feedback**: Success stories and praise
- **Trending Topics**: Patterns and emerging themes
- **Recommended Actions**: Prioritized with startup-appropriate timelines (days, not weeks)

## Customization

### Adjusting Analysis Criteria

Modify the agent prompts in `workspace.yml` to change how feedback is categorized or prioritized.

### Changing Summary Format

Edit the Slack message format template in the `summary-generator` agent prompt to customize the
output format.

### Timeline Adjustments

The workspace uses startup-appropriate timelines:

- Quick wins: 1-2 days
- Medium-term: 2-4 days
- Strategic: 1-2 weeks

Adjust these in the agent prompts if your team works on different timelines.

## Troubleshooting

### MCP Server Connection Issues

If the Slack MCP server fails to connect:

1. Verify your token has the required scopes
2. Check that the token is correctly set in the environment
3. Ensure the korotovsky/slack-mcp-server is accessible via npx

### Empty Summaries

If summaries are empty or missing data:

1. Verify the channel IDs are correct
2. Check that there are messages in the channel within the last 48 hours
3. Review the workspace logs: `atlas workspace logs slack-feedback-summarizer`

### Formatting Issues

If Slack formatting appears broken:

1. Ensure `content_type: "text/markdown"` is used
2. Use single asterisks (*) for bold, not double (**)
3. Test with simpler formatting first

## Example Output

The workspace generates detailed summaries like:

```
📊 *Atlas Feedback Summary* - August 4, 2025
_Analysis Period: Last 48 hours from #atlasfeedback_

*📈 Overview*
• Total Feedback Items: 9
• Active Contributors: 5
• Overall Sentiment: Mixed (44.4% Negative, 33.3% Neutral, 11.1% Positive, 11.1% Critical)
• Most Active Period: Afternoon (2-5pm)
• New vs Returning Contributors: 2 new, 3 returning

*🚨 Critical Issues*
• *Build Stability Problems*
  - Reported by: @user1, @user2 (4 total reports)
  - First reported: Yesterday 3:45pm
  - Impact: Preventing deployment and testing
  - Error details: _"Process crashes unexpectedly during build"_
  - Suggested action: Investigate build logs and rollback recent changes

[... continues with detailed sections ...]
```

## License

This workspace is provided as an example for Atlas users. Modify and use as needed for your team's
feedback management needs.
