# Release Notes

## 0.1.1

Review follow-up from the BOT-004 dev review.

- **Media download byte cap.** `lib/graph.js`'s `fetchBinary` (used by
  `download` for both WhatsApp media and the future Messenger/Instagram
  reuse) now enforces `bots.<id>.maxMediaBytes` (default 25 MB): rejected
  up front against `Content-Length` when present, and aborted mid-stream
  against a running total otherwise, instead of buffering the whole body
  into memory first. A file over the cap is skipped (`download` returns a
  null path) rather than failing the message.
- README: documented `maxMediaBytes` in the main config example and the
  "Media download" section.

## 0.1.0

Initial release — the `whatsapp` channel plugin for `aux4/bot`.

- Adds a `whatsapp` command to aux4/bot's `bot` profile, routing to a
  `bot:whatsapp` profile implementing the full six-command plugin contract
  (`verify`, `ingest-parse`, `typing`, `download`, `format`, `send`) against
  the WhatsApp Cloud API (Meta Graph API `v27.0`).
- `verify`: GET `hub.challenge` handshake (`hub.verify_token` match) and POST
  `X-Hub-Signature-256` HMAC-SHA256 verification over the byte-exact raw
  body.
- `ingest-parse`: normalizes `entry[].changes[].value.messages[]` (text and
  media) into core events; `value.statuses[]` (delivery/read/failed
  receipts) are intentionally skipped. Default dedupe window is 36 hours,
  matching Meta's own webhook retry window.
- `typing`: marks the inbound message read and raises the typing indicator.
- `download`: resolves a Graph media id to a CDN URL and downloads it.
- `format`: Markdown -> WhatsApp text markup (bold/italic/strike/code).
- `send`: splits replies over WhatsApp's 4096-char limit into multiple
  sequential messages.
- `send-template`: a standalone command for sending a pre-approved Message
  Template outside the 24h free-form session window.
- The Graph API host/version are overridable (`bots.<id>.apiUrl`/
  `apiVersion`, or `WHATSAPP_API_URL`/`WHATSAPP_API_VERSION`) so tests can
  point at a mock server instead of `https://graph.facebook.com`.
- Shared Meta signature/handshake logic (`lib/meta.js`) and Graph API client
  (`lib/graph.js`) are factored out for Messenger/Instagram to reuse.
