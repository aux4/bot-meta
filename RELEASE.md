# Release Notes

## 0.1.8 (unreleased)

BOT-018: extended `package/test/bot__whatsapp-e2e-providers.test.md`'s
per-provider matrix (memory, repository, sqs, cloud) with the deeper
failure/durability scenarios, through the real bot-meta/mock stack, for
every provider where they apply:

- brain failure -> retried up to `maxAttempts` -> `failureMessage` sent on
  the final attempt -> the message ends up in the provider's dead-letter
  queue (`aux4 queue dlq --provider <p>`).
- a long-running brain under a short `visibility` is never redelivered,
  thanks to the lease-renew heartbeat -- exactly one reply.
- push mode (`POST /bot/work`): a failing push is retried by a work queue's
  `--webhook` proxy until it succeeds. The proxy is a `memory`-storage-only
  aux4/queue feature, so this is proven alongside every provider's own main
  pipeline via a small dedicated memory queue pointed at that provider's
  `/bot/work` route.
- worker killed mid-brain -> restarted -> the message is leased again and
  replied to exactly once (`repository`, `sqs`, `cloud` -- not `memory`,
  which has no durable lease to resume from across a process restart).

No code changes in this package. Two real bugs were found and fixed
upstream while building the `sqs`/`cloud` scenarios (not in this package --
see `aux4/queue-sqs` and `aux4/queue-cloud` release notes): `queue-sqs`'s
`lease` reported SQS's raw 1-indexed `ApproximateReceiveCount` as `attempts`
instead of the 0-indexed "attempts already made" convention every other
provider uses, which made `aux4/bot`'s shared final-attempt check fire one
delivery early and then again, sending `failureMessage` twice for the same
event before the message was actually dead-lettered.

## 0.1.6

BOT-018: added `package/test/bot__whatsapp-e2e-providers.test.md` -- the same
WhatsApp pipeline as `bot__whatsapp-e2e.test.md` (mock Graph API -> `aux4 api`
-> `aux4 bot ingest` -> `aux4 queue` -> `aux4 bot worker` -> bot-meta `send` ->
the mock records the reply), run once per `aux4/queue` provider (`memory`,
`repository`, `sqs`, `cloud`) covering: a signed message gets exactly one
reply, redelivering the same event id is not reprocessed, and two messages to
the same chat get replies in the order sent. CI (`test-linux`) now installs
`aux4/queue-sqs`/`aux4/queue-cloud` via the `packages:` input and runs
ElasticMQ as a job-level `services:` container (same pattern as
`aux4/queue-sqs`'s own CI) to back the `sqs`/`cloud` sections. No code
changes; test + CI only.

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
