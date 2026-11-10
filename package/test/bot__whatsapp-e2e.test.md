# aux4 bot whatsapp, end-to-end against a mock Graph API

Exercises the full `aux4/bot` core pipeline with the `whatsapp` channel
plugin: a real `aux4 api` serves the webhook route, `aux4 bot ingest`
verifies the `X-Hub-Signature-256` HMAC over the byte-exact raw body and
claims/enqueues the event onto a real `aux4 queue`, and a real
`aux4 bot worker` process picks it up, runs the brain, and the plugin's
`typing`/`download`/`send` commands call a real `aux4/mock` server standing
in for `graph.facebook.com` (via each bot's `apiUrl` override).

Every payload fixture is declared here at the document root (not under a
`##` heading) so it is available to every test below, including ones in a
later, sibling heading (e.g. the duplicate-delivery test re-sends the same
signed-message fixture a first test already used).

```file:config.yaml
config:
  port: 18750
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-state.db"
    tmpDir: "test-wa-tmp"
    queueName: "bot.wa.e2e.test"
    queueUrl: "http://localhost:18751"
    dedupeTtl: 129600
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      brainRetries: 1
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18761/api"
        command: "node echobot.js"
      longbot:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18761/api"
        command: "node longbot.js"
      mediabot:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18761/api"
        command: "node catfile.cjs"
```

```file:echobot.js
process.stdout.write(process.argv[process.argv.length - 1]);
```

```file:longbot.js
process.stdout.write("A".repeat(4200));
```

```file:catfile.cjs
const fs = require("fs");
const file = (process.env.AUX4BOT_FILES || "").split(",")[0];
process.stdout.write(file ? fs.readFileSync(file, "utf8") : "(no file)");
```

```file:wa-text-body.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"contacts":[{"profile":{"name":"Alice"},"wa_id":"15551230001"}],"messages":[{"from":"15551230001","id":"wamid.TEXT1","timestamp":"1699999999","type":"text","text":{"body":"hello whatsapp"}}]}}]}]}
```

```file:wa-status-body.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"statuses":[{"id":"wamid.TEXT1","status":"delivered","timestamp":"1699999999","recipient_id":"15551230001"}]}}]}]}
```

```file:wa-batch-body.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15551230011","id":"wamid.BATCH1","timestamp":"1699999999","type":"text","text":{"body":"batch one"}},{"from":"15551230012","id":"wamid.BATCH2","timestamp":"1699999999","type":"text","text":{"body":"batch two"}}]}}]}]}
```

```file:wa-long-body.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15551230099","id":"wamid.LONG1","timestamp":"1699999999","type":"text","text":{"body":"give me the long answer"}}]}}]}]}
```

```file:wa-media-body.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15551230088","id":"wamid.MEDIAMSG1","timestamp":"1699999999","type":"image","image":{"id":"MEDIA1","mime_type":"application/octet-stream"}}]}}]}]}
```

```afterAll
aux4 api stop 2>/dev/null
aux4 queue stop --port 18751 2>/dev/null
aux4 mock stop --port 18761 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "bot.mjs worker" 2>/dev/null
rm -f test-wa-state.db queue.log api.log worker.log mock.log
rm -rf test-wa-tmp
true
```

## Server startup

A `beforeAll` hook runs BEFORE `file:` fixtures materialize, so the mock,
queue, api, and worker processes (which all need `config.yaml`/the brain
scripts on disk at startup) are started here, in the first `execute` block,
instead.

### should start the mock Graph API, the queue, the api server, and the worker

```execute
rm -f test-wa-state.db
rm -rf test-wa-tmp
nohup aux4 mock start --port 18761 >mock.log 2>&1 &
sleep 1
aux4 mock stub --port 18761 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
aux4 mock stub --port 18761 --method GET --path /v27.0/MEDIA1 --status 200 --body '{"url":"http://localhost:18761/api/cdn/MEDIA1.bin","mime_type":"application/octet-stream"}' >/dev/null
aux4 mock stub --port 18761 --method GET --path /cdn/MEDIA1.bin --status 200 --contentType application/octet-stream --body "downloaded-media-bytes" >/dev/null
nohup aux4 queue start --port 18751 >queue.log 2>&1 &
sleep 1
aux4 queue create --port 18751 --name bot.wa.e2e.test >/dev/null
nohup aux4 api start --configFile config.yaml >api.log 2>&1 &
sleep 1
nohup aux4 bot worker --configFile config.yaml --config bot >worker.log 2>&1 &
sleep 1
curl -s "http://localhost:18750/api/whatsapp/support/webhook?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=hs-wa-123"
```

```expect
hs-wa-123
```

## GET verification handshake

### should reject a wrong verify token with 403

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18750/api/whatsapp/support/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x"
```

```expect
403
```

### should 404 for an unconfigured channel

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18750/api/telegram/support/webhook?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=x"
```

```expect
404
```

### should 404 for an unconfigured bot id

```execute
curl -s -o /dev/null -w "%{http_code}" "http://localhost:18750/api/whatsapp/ghost/webhook?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=x"
```

```expect
404
```

## POST ingest — signature verification

### should reject a request with no signature header

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/whatsapp/support/webhook" -H "Content-Type: application/json" --data-binary '{"entry":[]}'
```

```expect
401
```

### should reject a request with a wrong signature

```execute
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=deadbeef" --data-binary '{"entry":[]}'
```

```expect
401
```

## POST ingest — a signed text message is acked, processed, and replied

### should accept the signed webhook, run the brain, and send the reply via the mock Graph API

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-text-body.json')).digest('hex'))")
curl -s -w "\nHTTP:%{http_code}\n" -X POST "http://localhost:18750/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-text-body.json
sleep 1.5
```

```expect:partial
HTTP:200
```

### the mock recorded a typing/read call and the echoed reply

```execute
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"status":"read"' --body-contains '"message_id":"wamid.TEXT1"'
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15551230001"' --body-contains '"hello whatsapp"'
```

```expect:partial
verify ok:**verify ok:*
```

## POST ingest — duplicate delivery is acked but NOT reprocessed

### redelivering the same event id is still acked 200

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-text-body.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-text-body.json
sleep 1
```

```expect
200
```

### the duplicate was NOT reprocessed — still exactly one reply to this chat

```execute
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15551230001"' --body-contains '"hello whatsapp"' --times 1
```

```expect:partial
verify ok:*
```

## POST ingest — a status-only webhook is acked but ignored

### should ack 200 and never call the brain or the mock send endpoint for it

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-status-body.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-status-body.json
sleep 1
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"status":"delivered"'
```

```expect
200
```

```error:partial
verify failed:*
```

## POST ingest — a batch of 2 messages in one POST

### should process and reply to both messages in the batch

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-batch-body.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-batch-body.json
sleep 1.5
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15551230011"' --body-contains '"batch one"'
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15551230012"' --body-contains '"batch two"'
```

```expect:partial
200**verify ok: 1 match(es)**verify ok: 1 match(es)*
```

## POST ingest — a long reply is split into multiple messages

### a reply over 4096 chars is sent as two separate messages to the same chat

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-long-body.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/whatsapp/longbot/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-long-body.json
sleep 1.5
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15551230099"' --body-contains '"type":"text"' --times 2
```

```expect:partial
200**verify ok: 2 match(es)*
```

## POST ingest — media download

### the attached media is resolved, downloaded, and handed to the brain

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-media-body.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18750/api/whatsapp/mediabot/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-media-body.json
sleep 1.5
aux4 mock verify --port 18761 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15551230088"' --body-contains 'downloaded-media-bytes'
```

```expect:partial
200**verify ok:*
```
