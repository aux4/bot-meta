#### Description

`whatsapp` is a real channel plugin for [aux4/bot](https://hub.aux4.io/r/public/packages/aux4/bot),
implementing the full six-command plugin contract (`verify`, `ingest-parse`,
`typing`, `download`, `format`, `send`) against the **WhatsApp Cloud API**
(Meta's Graph API). See the aux4/bot README's "Writing a channel plugin"
section for the contract every channel plugin implements, and this
package's README "WhatsApp setup" for the full Meta-side configuration walk
(app secret, verify token, access token, webhook registration).

- **`verify`** — a `GET` request is the platform's handshake:
  `?hub.mode=subscribe&hub.challenge=<n>&hub.verify_token=<token>`, checked
  against the bot's configured `verifyToken` and echoed back verbatim when
  it matches. A `POST` is checked via `X-Hub-Signature-256:
  sha256=<hex HMAC-SHA256(appSecret, raw body)>`, computed over the
  byte-exact raw body and compared in constant time.
- **`ingest-parse`** — walks `entry[].changes[].value`. Each
  `value.messages[]` entry becomes one normalized event (`key` = the
  message id, `chatId`/`userId` = the sender's WhatsApp id, `text` =
  `message.text.body`, `files` = one entry per attached
  image/video/audio/document/sticker). `value.statuses[]` (delivery/read/
  failed receipts) are never normalized — they don't reach the queue. The
  dedupe `ttl` defaults to 36 hours (`bots.<id>.dedupeTtl` overrides),
  matching how long Meta itself retries an undelivered webhook.
- **`typing`** — marks the inbound message read and raises the typing
  indicator in one call (`POST {phoneNumberId}/messages` with
  `status:"read"` and `typing_indicator`). Best-effort; a failure here never
  blocks the reply.
- **`download`** — resolves a media id to a time-limited CDN URL
  (`GET /{media-id}`), then downloads it (both calls Bearer-authenticated
  with `bot.token`), writing it to `tmpDir/<media-id><ext>`.
- **`format`** — converts Markdown into WhatsApp's own text markup:
  `**bold**`/`__bold__` → `*bold*`, `*italic*`/`_italic_` → `_italic_`,
  `~~strike~~` → `~strike~`, fenced code blocks pass through unchanged.
- **`send`** — posts `{messaging_product:"whatsapp", to, type:"text",
  text:{body}}` to `POST {phoneNumberId}/messages`. Text exceeding
  WhatsApp's 4096-char limit is split into multiple sequential messages
  (preferring a blank-line, then newline, then space boundary). If Meta
  rejects the send because the 24h free-form session window has elapsed
  (Graph API error code `131047`), `send` refuses with a clear
  `{ok:false, error}` pointing at `aux4 bot whatsapp send-template` instead
  of surfacing Meta's own terse error text — this is what `aux4 bot send`
  (aux4/bot core) and the worker's own best-effort reply path both see.

These subcommands are invoked by the aux4/bot core (`aux4 bot verify`/
`ingest`/`worker`) and are not meant to be run directly. For sending
outside the 24h free-form session window, see `aux4 bot whatsapp
send-template`.

The Graph API host/version are overridable (`bots.<id>.apiUrl`/
`apiVersion`, or `WHATSAPP_API_URL`/`WHATSAPP_API_VERSION`) so a test suite
can point this plugin at a mock Graph API instead of
`https://graph.facebook.com`.

#### Usage

```yaml
config:
  bot:
    channels: ["whatsapp"]
    dedupeTtl: 129600
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "109876543210123"
        verifyToken: ${WHATSAPP_VERIFY_TOKEN}
        appSecret: ${WHATSAPP_APP_SECRET}
        token: ${WHATSAPP_ACCESS_TOKEN}
        command: "aux4 ai agent ask --instructions support.md"
```

#### Example

```bash
aux4 queue start --port 8430
aux4 api start --configFile config.yaml
aux4 bot worker --configFile config.yaml --config bot
```

```text
[bot worker] connecting to queue bot.inbound on port 8430
```

A WhatsApp message sent to the configured business number arrives as a
signed webhook POST, is verified, parsed, queued, picked up by the worker,
answered by the configured brain command, and replied to the same chat.
