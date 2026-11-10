# aux4/bot-meta

A [Meta](https://developers.facebook.com/docs/graph-api/webhooks) channel plugin
family for [aux4/bot](https://hub.aux4.io/r/public/packages/aux4/bot) — WhatsApp
Cloud API first, with Messenger and Instagram sharing the same webhook
transport (verify handshake + signature) as later additions to this package.

aux4/bot owns the generic webhook lifecycle (verify → dedupe → enqueue → ack →
work → reply) and the brain ("answer the question"); this package is the
**transport** for one platform family: it knows how to verify a Meta
webhook, parse WhatsApp's payload shape, download WhatsApp media, format
Markdown into WhatsApp's own text markup, and send a WhatsApp message.

## Installation

```bash
aux4 aux4 pkger install aux4/bot-meta
```

Installing this package adds a `whatsapp` command to aux4/bot's `bot`
profile — `aux4 bot whatsapp` — see
[aux4/bot "Writing a channel plugin"](https://hub.aux4.io/r/public/packages/aux4/bot#writing-a-channel-plugin)
for how the merge works.

## WhatsApp setup

### 1. Create a Meta app and a WhatsApp Business Account

In [developers.facebook.com](https://developers.facebook.com), create an app,
add the **WhatsApp** product, and note:

- **Phone number ID** — under WhatsApp → API Setup.
- **App secret** — under App Settings → Basic.
- **Access token** — a temporary token works for testing; for production,
  generate a permanent **system-user access token** with the
  `whatsapp_business_messaging` permission.

### 2. Configure a bot entry

```yaml
config:
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true

  bot:
    channels: ["whatsapp"]
    db: "./.bot/state.db"
    tmpDir: "./.bot/tmp"
    queueName: "bot.inbound"
    queueUrl: "http://localhost:8430"
    dedupeTtl: 129600                 # 36h — matches Meta's own webhook retry window
    defaults:
      threadTtl: 86400
      replyTtl: 3600
      brainTimeout: 120000
      brainRetries: 2

    bots:
      support:
        channel: whatsapp
        phoneNumberId: "109876543210123"          # WhatsApp API Setup page
        verifyToken: ${WHATSAPP_VERIFY_TOKEN}       # a string YOU choose; entered into the Meta dashboard
        appSecret: ${WHATSAPP_APP_SECRET}           # App Settings -> Basic -> App Secret
        token: ${WHATSAPP_ACCESS_TOKEN}             # a permanent system-user access token
        maxMediaBytes: 26214400                     # optional — cap on a single media download, default 25 MB
        command: "aux4 ai agent ask --instructions support.md"
```

`phoneNumberId`, `verifyToken`, `appSecret`, and `token` are read verbatim by
this plugin — pass secrets by environment variable reference
(`${WHATSAPP_APP_SECRET}`) rather than writing them into the file; aux4/bot's
core expands `${ENV_VAR}` references inside any bot config field.

### 3. Register the webhook in the Meta dashboard

WhatsApp → Configuration → Webhook. Callback URL:
`https://your-host/api/whatsapp/support/webhook`, Verify token: the same
value as `verifyToken` above. Meta sends a GET request with
`hub.mode=subscribe&hub.challenge=<n>&hub.verify_token=<token>` — this
plugin's `verify` command checks the token and echoes the challenge back.
Subscribe to the `messages` webhook field.

### 4. Run the full stack

```bash
aux4 queue start --port 8430
aux4 api start --configFile config.yaml
aux4 bot worker --configFile config.yaml --config bot
```

Send a WhatsApp message to the business number — it arrives as a signed
webhook POST, is parsed, queued, picked up by the worker, answered by the
configured brain command, and replied to the same chat.

## Signature verification

Every POST carries `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret,
raw body)>`. This plugin's `verify` command computes the same HMAC over the
byte-exact raw body aux4/bot's core hands it (see
[aux4/api's `event.rawBody`](https://hub.aux4.io/r/public/packages/aux4/api))
and compares in constant time — a request with a missing or mismatched
signature is rejected with `401` before any parsing happens. The GET
handshake instead compares `hub.verify_token` against the bot's configured
`verifyToken` and echoes `hub.challenge` back verbatim.

## Parsing (ingest-parse)

A webhook POST body is `{ entry: [ { changes: [ { value: {...} } ] } ] }`.
Batching is not guaranteed — a single POST can carry 1..N entries/changes,
and this plugin walks every one of them.

- `value.messages[]` — one entry per inbound message. Each becomes a
  normalized event: `key` = the message id (aux4/bot's dedupe key), `chatId`
  / `userId` = the sender's WhatsApp id (`message.from`), `text` =
  `message.text.body` (empty for a pure-media message), `files` = one entry
  per attached media (`image`/`video`/`audio`/`document`/`sticker`) carrying
  the Graph API media id for the `download` step.
- `value.statuses[]` — delivery/read/failed receipts for messages **this**
  bot sent. These are never normalized into an event — they don't reach the
  queue, so the brain never sees them.

The dedupe window defaults to **36 hours**, matching how long Meta itself
will keep retrying an undelivered webhook — override per bot with
`bots.<id>.dedupeTtl` (seconds).

## Media download

Media arrives as an opaque id, not a URL. `download` makes two Bearer-
authenticated Graph API calls: `GET /{media-id}` resolves it to a
time-limited CDN `url` (plus `mime_type`), then that URL is fetched directly
and written to `tmpDir/<media-id><ext>`.

The download is capped at `bots.<id>.maxMediaBytes` (default **25 MB**). The
cap is checked against the response's `Content-Length` up front when
present, and against the running total while streaming otherwise — the
download is aborted the moment the cap is exceeded rather than buffering an
oversized file into memory first. A file over the cap is skipped (`download`
returns a null path) instead of failing the whole message; the brain simply
runs without that attachment.

## Formatting and the 4096-char split

`format` converts the brain's Markdown into WhatsApp's own text markup:

| Markdown | WhatsApp |
|---|---|
| `**bold**` / `__bold__` | `*bold*` |
| `*italic*` / `_italic_` | `_italic_` |
| `~~strike~~` | `~strike~` |
| ` ```code``` ` | ` ```code``` ` (unchanged) |

Fenced code blocks are protected from every other substitution. `send`
splits the formatted text into multiple sequential messages whenever it
exceeds WhatsApp's 4096-character limit per message, preferring to cut on a
blank line, then a newline, then a space.

## Sending

`send` posts `POST /{phoneNumberId}/messages` with
`{messaging_product:"whatsapp", to, type:"text", text:{body}}`, Bearer-
authenticated with `bot.token`. This only works within WhatsApp's 24-hour
free-form session window (since the user's last message).

### Outside the 24h window: send-template

```bash
aux4 bot whatsapp send-template support \
  --to 15551234567 \
  --template order_shipped \
  --languageCode en_US \
  --params '["Order #4821", "2026-11-12"]' \
  --configFile config.yaml --config bot
```

Sends a pre-approved WhatsApp Message Template (required to initiate contact
or reply outside the 24h window). `params` fills the template's `body`
component parameters, in order, as plain text values. The template itself
(name, language, and parameter count) must already be approved in the Meta
dashboard before this will succeed.

## Overriding the Graph API host (for tests)

The Graph API base URL and version are overridable — per bot
(`bots.<id>.apiUrl` / `bots.<id>.apiVersion`) or via the
`WHATSAPP_API_URL` / `WHATSAPP_API_VERSION` environment variables — so a
test suite can point this plugin at a local mock server instead of
`https://graph.facebook.com`. Production deployments should leave both
unset (defaults: `https://graph.facebook.com`, `v27.0`).

## License

Apache-2.0
