---
from: priya@acme-corp.example
subject: "Heads up: incident postmortem at 2pm"
date: 2026-04-04T11:21:00Z
labels: ["unread", "inbox"]
tone: work-thread
---

Quick recap of standup since a few people were out: backend is unblocked on the gateway migration; frontend is waiting on the design review for the new flows (Priya, can you confirm timing?); and ops flagged a slow-leaking memory issue on prod-worker-3 that they're investigating.

Action items: I'll book a postmortem slot for the incident from yesterday; Sam's drafting the comms; and we should plan to reduce on-call load next sprint — three pages overnight is too many.
