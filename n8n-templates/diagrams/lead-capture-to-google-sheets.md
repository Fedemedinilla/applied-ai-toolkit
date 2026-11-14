# Lead capture to Google Sheets

Graph of `templates/lead-capture-to-google-sheets.json`, written by `scripts/docs.ts`. Do not edit it by hand.

```mermaid
flowchart LR
  n0(["Receive lead (Webhook)"])
  n1{"Has a valid email?"}
  n2["Normalize fields"]
  n3["Save to Google Sheets"]
  n4["Discard (no valid email)"]
  n0 --> n1
  n1 -- true --> n2
  n1 -- false --> n4
  n2 --> n3
```
