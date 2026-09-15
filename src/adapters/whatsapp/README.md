# WhatsApp adapter

`webhook.ts` authenticates and parses Meta callbacks. `client.ts` sends text,
buttons, and lists through the Cloud API. `conversation.ts` implements deterministic
patient-only flows using the unchanged appointment service. `store.ts` coordinates
durable inbox/session/outbox state with clinic SQLite transactions.

See [architecture, configuration, and verification](../../../docs/whatsapp.md).
No Meta credentials or live setup are included.
