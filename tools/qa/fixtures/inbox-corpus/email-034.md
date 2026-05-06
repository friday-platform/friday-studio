---
from: alerts@datadoghq.example
subject: "Suspicious sign-in attempt detected"
date: 2026-04-07T18:58:00Z
labels: ["unread", "inbox", "important"]
tone: alert
---

A new high-severity security advisory was published affecting one of your project's transitive dependencies. The vulnerability allows for remote code execution under specific conditions detailed in the linked CVE.

Recommended action: bump the affected package to the patched version. Dependabot has already opened a PR for review; merge as soon as your CI is green.
