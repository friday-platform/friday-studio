---
from: security@github.example
subject: "[Datadog] CPU on prod-api-7 exceeded 85% for 10m"
date: 2026-04-23T18:34:00Z
labels: ["unread", "inbox", "important"]
tone: alert
---

The CPU utilization metric for the host prod-api-7 has exceeded 85% for the past 10 minutes. The current value is 91%. This is a P3 alert — investigate when convenient.

Common causes: traffic spike, runaway query, or a leaking process. Check the runbook for triage steps.
