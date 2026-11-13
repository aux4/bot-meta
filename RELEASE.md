# Release Notes

## 0.1.13

The crash-resume scenario in each provider section (repository/sqs/cloud)
used a fixed `sleep 15` to give the restarted worker time to finish the
slow (8s-sleeping) brain before being killed for the test's own cleanup —
a classic "fixed sleep where a poll-until-condition is needed" case: under
CI load the full cycle (spawn worker, lease, spawn node, sleep 8s, send
reply) can occasionally take longer than 15s, so the worker got killed
before it sent the reply it was proven (one CI run) to otherwise complete.
Replaced the fixed sleep with a poll loop (up to 25s) that breaks as soon
as `aux4 mock verify` confirms the reply arrived, instead of widening the
sleep constant. Verified locally: 3 consecutive green `providers` group
runs (31/31 each), each now finishing in ~300-320s (down from ~326s) since
the poll exits early once the reply lands.

## 0.1.12

The provider-matrix CI job (0.1.11) still failed once on "Exceeded timeout
of 5000 ms for a hook" on 2 of the 4 provider sections' `afterAll` — their
real cleanup (AWS CLI `queue delete` calls against ElasticMQ, process
kills) occasionally runs past jest's default 5s hook budget under CI load.
Each `## Provider: X` heading's own `afterAll`/`beforeAll` only inherited
jest's default unless a `timeout` block was set directly in that heading's
own scope (not a descendant `###` test's `timeout`, which is independent).
Added a `timeout: 60000` block directly under each of the 4 provider
headings. Verified locally: 2 further consecutive green `providers` group
runs (31/31 each, ~327s) on top of the 5 already recorded for 0.1.11.

## 0.1.11

Split CI's `test-linux` job into two independent, parallel jobs
(`test-linux-core`, `test-linux-providers`) via a new `package/test/test.suite.md`.
Even with the port-collision and readiness-poll fixes from 0.1.10, two
real CI runs still reproduced the historical flake: `bot__whatsapp-e2e.test.md`
(the smaller single-provider file, which always runs LAST alphabetically)
got zero delivered messages across the board whenever it ran right after
the much larger `bot__whatsapp-e2e-providers.test.md` matrix on the same
runner/job — the combined suite ran as one ~400s single jest process on a
job that also kept an ElasticMQ service container alive for its entire
duration (even during the sections that don't need it). Each group now
runs on its own fresh GitHub Actions runner; `test-linux-providers` keeps
the ElasticMQ service (scoped to only the job that needs it),
`test-linux-core` no longer carries that overhead at all. Verified locally:
5 consecutive runs of each group independently green (`core`: 42/42 in
~37s; `providers`: 31/31 in ~326s).

## 0.1.10

Fixed the real root cause of the intermittent CI test-linux failures (not a
timing/sleep issue): `package/test/bot_whatsapp__download.test.md` and
`package/test/bot_whatsapp__send-template.test.md` both started an
`aux4/mock` server on the SAME hardcoded port (`18762`) with no `--name`,
which also makes them share the same on-disk mock state directory
(`/tmp/aux4-mock/18762`, keyed purely by port). Whenever the first file's
server hadn't fully released the port before the second file's `beforeAll`
tried to rebind it (more likely under CI's load/resource contention),
`send-template`'s own stub/verify traffic landed on a stale or dead mock
process, producing exactly the previously-reported symptoms: `mock verify:
recorded 0 request(s)` and, when the stale process had actually died,
`connection refused`. Moved `send-template`'s test to its own port (`18764`)
so every server across the whole test suite now has a unique port. Verified
with 5 consecutive full local `aux4 test run` passes (73/73 each, reproduced
faithfully in an isolated `HOME` sandbox with the package pkger-installed
from a built zip, matching CI's install-then-test model) and no leaked
server processes between runs.

## 0.1.9

BOT-012 part B: the WhatsApp channel plugin's `send` now refuses with a
clear, actionable error instead of a bare `{ok:false}` when Meta's Graph
API rejects a message because the 24h free-form session window has
elapsed (error code `131047`) — pointing at `aux4 bot whatsapp
send-template`. This is what aux4/bot core's new `aux4 bot send` (ad hoc
sends) and the worker's own best-effort reply path both see.

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
