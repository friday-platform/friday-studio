---
from: security@github.example
subject: "[Datadog] CPU on prod-api-7 exceeded 85% for 10m"
date: 2026-04-17T12:52:00Z
labels: ["unread", "inbox", "important"]
tone: alert
---

A new high-severity security advisory was published affecting one of your project's transitive dependencies. The vulnerability allows for remote code execution under specific conditions detailed in the linked CVE.

Recommended action: bump the affected package to the patched version. Dependabot has already opened a PR for review; merge as soon as your CI is green.
