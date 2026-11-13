# aux4 bot whatsapp, end-to-end against a mock Graph API, across every aux4/queue provider

The SAME WhatsApp pipeline as `bot__whatsapp-e2e.test.md` (mock Graph API ->
`aux4 api` -> `aux4 bot ingest` -> `aux4 queue` -> `aux4 bot worker` -> bot-meta
`send` -> the mock records the reply), run once per `aux4/queue` provider:
`memory`, `repository`, `sqs` (ElasticMQ), and `cloud` (ElasticMQ, via
`aux4/queue-cloud`'s env+scope naming). Each provider section covers the same
three core scenarios:

1. a signed message gets exactly one reply,
2. redelivering the same event id is not reprocessed, and
3. two messages sent to the same chat get replies in the order sent.

`sqs` and `cloud` require `aux4/queue-sqs` and `aux4/queue-cloud` installed
(the CI workflow's `packages:` input does this) and an ElasticMQ server
reachable at `http://localhost:19781` (started as a job-level `services:`
container in CI; locally, start it yourself first):

```bash
docker run -d --name bot-meta-test-elasticmq -p 19781:9324 softwaremill/elasticmq-native
```

The deeper failure/retry/DLQ/crash-resume/lease-renew scenarios for this pipeline
are intentionally NOT duplicated here for every provider — they are already
proven, for `memory` and `repository`, via `aux4/bot`'s own lighter-weight
`echo` reference-plugin suite (`bot__echo-e2e.test.md`,
`bot__workqueue-repository.test.md`, `bot__crash-resume.test.md`). Extending
that depth to `sqs`/`cloud`, and/or to this bot-meta/mock stack specifically,
is tracked as follow-up work, not attempted in this file.

## Provider: memory

```file:config.yaml
config:
  port: 18800
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-mem-state.db"
    tmpDir: "test-wa-mem-tmp"
    dedupeTtl: 129600
    queue:
      provider: "memory"
      name: "bot.wa.mem.test"
      db: ".queue.db"
      visibility: "30"
      maxAttempts: "5"
      port: "18801"
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      failureMessage: "Sorry, something went wrong processing your message."
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18802/api"
        command: "node echobot.js"
```

```file:echobot.js
import fs from "fs";

async function main() {
  const text = process.argv[process.argv.length - 1] || "";
  const chatId = process.env.AUX4BOT_CHAT_ID || "";

  if (text.startsWith("FAIL_ALWAYS")) {
    process.stderr.write("boom-always\n");
    process.exit(1);
  }

  if (text.startsWith("FAIL_ONCE")) {
    const marker = `.echobot-marker-${chatId}`;
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "1");
      process.stderr.write("boom-once\n");
      process.exit(1);
    }
  }

  if (text.startsWith("SLOW_")) {
    const seconds = Number(text.split("_")[1]) || 5;
    await new Promise(r => setTimeout(r, seconds * 1000));
  }

  process.stdout.write(text);
}

main();
```

```file:wa-mem-msg1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"contacts":[{"profile":{"name":"Alice"}}],"messages":[{"from":"15559990001","id":"wamid.MEM1","timestamp":"1699999999","type":"text","text":{"body":"hello memory"}}]}}]}]}
```

```afterAll
aux4 api stop --port 18800 2>/dev/null
aux4 queue stop --provider memory --port 18801 2>/dev/null
aux4 mock stop --port 18802 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "aux4 bot work" 2>/dev/null
pkill -f "aux4 bot pull" 2>/dev/null
rm -f test-wa-mem-state.db
rm -rf test-wa-mem-tmp
rm -f .echobot-marker-15559990003 .echobot-marker-15559990005
rm -f renew-mem-state.db renew-mem-outbox.ndjson renew-mem-pull.log
rm -rf renew-mem-tmp
true
```

### should start the mock, the memory queue, the api server, and the worker

```execute
nohup aux4 mock start --port 18802 >mock-mem.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18802/
aux4 mock stub --port 18802 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
nohup aux4 queue start --provider memory --port 18801 >queue-mem.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18801/
aux4 queue create --provider memory --port 18801 --name bot.wa.mem.test --workQueue true --maxAttempts 5 >/dev/null
nohup aux4 api start --configFile config.yaml >api-mem.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18800/
nohup aux4 bot worker --configFile config.yaml --config bot >worker-mem.log 2>&1 &
sleep 1
curl -s "http://localhost:18800/api/whatsapp/support/webhook?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=hs-mem"
```

```expect
hs-mem
```

### a signed message gets exactly one reply

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-mem-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18800/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-mem-msg1.json
sleep 3
aux4 mock verify --port 18802 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15559990001"' --body-contains '"hello memory"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### redelivering the same event id is not reprocessed

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-mem-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18800/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-mem-msg1.json
sleep 1
aux4 mock verify --port 18802 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15559990001"' --body-contains '"hello memory"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### two messages to the same chat get replies in the order sent

```timeout
15000
```

```file:wa-mem-ord1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15559990002","id":"wamid.MEMORD1","timestamp":"1699999999","type":"text","text":{"body":"first message"}}]}}]}]}
```

```file:wa-mem-ord2.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15559990002","id":"wamid.MEMORD2","timestamp":"1699999999","type":"text","text":{"body":"second message"}}]}}]}]}
```

```execute
SIG1=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-mem-ord1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18800/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG1" --data-binary @wa-mem-ord1.json
sleep 0.5
SIG2=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-mem-ord2.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18800/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG2" --data-binary @wa-mem-ord2.json
sleep 5
aux4 mock requests --port 18802 --method POST --path /v27.0/PHONE123/messages | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); const toThisChat=r.filter(x=>x.body.includes('15559990002')); console.log(toThisChat.map(x=>x.body.includes('first message')?'first':x.body.includes('second message')?'second':'other').join(','))"
```

```expect
first,second
```

### a brain failure is retried up to maxAttempts, a failureMessage is sent on the final attempt, and the message ends up in the DLQ

```timeout
40000
```

```file:wa-mem-fail1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15559990003","id":"wamid.MEMFAIL1","timestamp":"1699999999","type":"text","text":{"body":"FAIL_ALWAYS boom"}}]}}]}]}
```

```execute
rm -f .echobot-marker-15559990003
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-mem-fail1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18800/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-mem-fail1.json
sleep 30
aux4 mock verify --port 18802 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15559990003"' --body-contains 'Sorry, something went wrong' --times 1
aux4 queue dlq --provider memory --port 18801 --name bot.wa.mem.test | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r.filter(m=>m.body.event.key==='wamid.MEMFAIL1').length)"
```

```expect:partial
verify ok: 1 match(es)**1
```

### a long brain under a short visibility is not redelivered, thanks to the renew heartbeat (exactly one reply)

`aux4 bot worker`'s loop above leases from `bot.wa.mem.test` with `visibility: 30`,
too long to race in a reasonable test time. This self-leases from a SEPARATE
memory queue (same server, port 18801) with a short `visibility`, directly via
one `aux4 bot work --mode pull` call -- bypassing the long-running worker loop
so the timing is fully controlled, the same pattern used in `aux4/bot`'s own
`bot__echo-e2e.test.md`.

```timeout
35000
```

```execute
aux4 queue create --provider memory --port 18801 --name bot.wa.mem.renew --workQueue true --maxAttempts 2 >/dev/null
rm -f renew-mem-outbox.ndjson
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-mem-renew-1","chatId":"15559990004","text":"SLOW_8 done"}}' | aux4 queue send --provider memory --port 18801 --name bot.wa.mem.renew --group 15559990004 >/dev/null
nohup aux4 bot work --mode pull --channels '["whatsapp"]' --bots '{"support":{"channel":"whatsapp","phoneNumberId":"PHONE123","verifyToken":"verify-tok","appSecret":"testappsecret","token":"test-access-token","apiUrl":"http://localhost:18802/api","command":"node echobot.js"}}' --defaults '{"failureMessage":"Sorry, something went wrong processing your message."}' --db renew-mem-state.db --tmpDir renew-mem-tmp --queue '{"provider":"memory","name":"bot.wa.mem.renew","db":"","visibility":"3","maxAttempts":"2","port":"18801","token":""}' >renew-mem-pull.log 2>&1 &
PULLPID=$!
sleep 5
aux4 queue lease --provider memory --name bot.wa.mem.renew --port 18801 --visibility 3 >/dev/null 2>&1
echo "mid-run lease exit=$?"
wait $PULLPID
sleep 1
aux4 mock verify --port 18802 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15559990004"' --body-contains '"SLOW_8 done"' --times 1
rm -f renew-mem-state.db renew-mem-outbox.ndjson renew-mem-pull.log
rm -rf renew-mem-tmp
aux4 queue delete --provider memory --port 18801 --name bot.wa.mem.renew >/dev/null 2>&1
```

```expect:partial
mid-run lease exit=4**verify ok: 1 match(es)*
```

### push mode: a failing push to /bot/work is retried by the queue's webhook until it succeeds

`POST /bot/work` is provider-agnostic (it processes the given event directly,
no lease) -- the "retry" guarantee comes from a work queue's `--webhook` proxy
(lease/ack/nack on the push itself), which is a `memory`-storage-only queue
feature regardless of which provider the bot's own `queue.provider` uses for
its main pipeline. This proves it works alongside every provider by pointing
a small dedicated memory work queue's webhook at this section's `/bot/work`
route.

```execute
aux4 queue create --provider memory --port 18801 --name bot.wa.mem.push --workQueue true --maxAttempts 3 --webhook http://localhost:18800/api/bot/work >/dev/null
rm -f .echobot-marker-15559990005
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-mem-push-1","chatId":"15559990005","text":"FAIL_ONCE hi"}}' | aux4 queue send --provider memory --port 18801 --name bot.wa.mem.push --group 15559990005 >/dev/null
sleep 3
aux4 mock verify --port 18802 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15559990005"' --body-contains '"FAIL_ONCE hi"' --times 1
rm -f .echobot-marker-15559990005
aux4 queue delete --provider memory --port 18801 --name bot.wa.mem.push >/dev/null 2>&1
```

```expect:partial
verify ok: 1 match(es)*
```

## Provider: repository

```file:config.yaml
config:
  port: 18810
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-repo-state.db"
    tmpDir: "test-wa-repo-tmp"
    dedupeTtl: 129600
    queue:
      provider: "repository"
      name: "bot.wa.repo.test"
      db: "test-wa-repo-queue.db"
      visibility: "30"
      maxAttempts: "5"
      port: ""
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      failureMessage: "Sorry, something went wrong processing your message."
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18812/api"
        command: "node echobot.js"
```

```file:echobot.js
import fs from "fs";

async function main() {
  const text = process.argv[process.argv.length - 1] || "";
  const chatId = process.env.AUX4BOT_CHAT_ID || "";

  if (text.startsWith("FAIL_ALWAYS")) {
    process.stderr.write("boom-always\n");
    process.exit(1);
  }

  if (text.startsWith("FAIL_ONCE")) {
    const marker = `.echobot-marker-${chatId}`;
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "1");
      process.stderr.write("boom-once\n");
      process.exit(1);
    }
  }

  if (text.startsWith("SLOW_")) {
    const seconds = Number(text.split("_")[1]) || 5;
    await new Promise(r => setTimeout(r, seconds * 1000));
  }

  process.stdout.write(text);
}

main();
```

```file:wa-repo-msg1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15558880001","id":"wamid.REPO1","timestamp":"1699999999","type":"text","text":{"body":"hello repository"}}]}}]}]}
```

```afterAll
aux4 api stop --port 18810 2>/dev/null
aux4 mock stop --port 18812 2>/dev/null
aux4 queue stop --provider memory --port 18813 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "aux4 bot work" 2>/dev/null
pkill -f "aux4 bot pull" 2>/dev/null
rm -f test-wa-repo-state.db test-wa-repo-queue.db
rm -rf test-wa-repo-tmp
rm -f .echobot-marker-15558880003 .echobot-marker-15558880005
rm -f renew-repo-state.db renew-repo-pull.log wa-repo-crash1.json
rm -rf renew-repo-tmp
true
```

### should start the mock, the repository queue, the api server, and the worker

```execute
rm -f test-wa-repo-queue.db
aux4 queue create --provider repository --db test-wa-repo-queue.db --name bot.wa.repo.test --maxAttempts 5 >/dev/null
nohup aux4 mock start --port 18812 >mock-repo.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18812/
aux4 mock stub --port 18812 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
nohup aux4 api start --configFile config.yaml >api-repo.log 2>&1 &
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18810/
nohup aux4 bot worker --configFile config.yaml --config bot >worker-repo.log 2>&1 &
echo $! > worker-repo.pid
sleep 1
curl -s "http://localhost:18810/api/whatsapp/support/webhook?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=hs-repo"
```

```expect
hs-repo
```

### a signed message gets exactly one reply

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-repo-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18810/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-repo-msg1.json
sleep 3
aux4 mock verify --port 18812 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15558880001"' --body-contains '"hello repository"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### redelivering the same event id is not reprocessed

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-repo-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18810/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-repo-msg1.json
sleep 1
aux4 mock verify --port 18812 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15558880001"' --body-contains '"hello repository"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### two messages to the same chat get replies in the order sent

```timeout
15000
```

```file:wa-repo-ord1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15558880002","id":"wamid.REPOORD1","timestamp":"1699999999","type":"text","text":{"body":"first message"}}]}}]}]}
```

```file:wa-repo-ord2.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15558880002","id":"wamid.REPOORD2","timestamp":"1699999999","type":"text","text":{"body":"second message"}}]}}]}]}
```

```execute
SIG1=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-repo-ord1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18810/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG1" --data-binary @wa-repo-ord1.json
sleep 0.5
SIG2=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-repo-ord2.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18810/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG2" --data-binary @wa-repo-ord2.json
sleep 5
aux4 mock requests --port 18812 --method POST --path /v27.0/PHONE123/messages | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); const toThisChat=r.filter(x=>x.body.includes('15558880002')); console.log(toThisChat.map(x=>x.body.includes('first message')?'first':x.body.includes('second message')?'second':'other').join(','))"
```

```expect
first,second
```

### a brain failure is retried up to maxAttempts, a failureMessage is sent on the final attempt, and the message ends up in the DLQ

```timeout
40000
```

```file:wa-repo-fail1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15558880003","id":"wamid.REPOFAIL1","timestamp":"1699999999","type":"text","text":{"body":"FAIL_ALWAYS boom"}}]}}]}]}
```

```execute
rm -f .echobot-marker-15558880003
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-repo-fail1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18810/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-repo-fail1.json
sleep 30
aux4 mock verify --port 18812 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15558880003"' --body-contains 'Sorry, something went wrong' --times 1
aux4 queue dlq --provider repository --db test-wa-repo-queue.db --name bot.wa.repo.test --maxAttempts 5 | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r.filter(m=>m.body.event.key==='wamid.REPOFAIL1').length)"
```

```expect:partial
verify ok: 1 match(es)**1
```

### a long brain under a short visibility is not redelivered, thanks to the renew heartbeat (exactly one reply)

A SEPARATE repository queue (`bot_wa_repo_renew`, same db file, underscore-only
name per the repository-storage SQL-identifier constraint) with a short
`visibility`, leased directly via one `aux4 bot work --mode pull` call --
bypassing the long-running worker loop above so the timing is fully
controlled.

```timeout
35000
```

```execute
aux4 queue create --provider repository --db test-wa-repo-queue.db --name bot_wa_repo_renew --maxAttempts 2 >/dev/null
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-repo-renew-1","chatId":"15558880004","text":"SLOW_8 done"}}' | aux4 queue send --provider repository --db test-wa-repo-queue.db --name bot_wa_repo_renew --group 15558880004 >/dev/null
nohup aux4 bot work --mode pull --channels '["whatsapp"]' --bots '{"support":{"channel":"whatsapp","phoneNumberId":"PHONE123","verifyToken":"verify-tok","appSecret":"testappsecret","token":"test-access-token","apiUrl":"http://localhost:18812/api","command":"node echobot.js"}}' --defaults '{"failureMessage":"Sorry, something went wrong processing your message."}' --db renew-repo-state.db --tmpDir renew-repo-tmp --queue '{"provider":"repository","name":"bot_wa_repo_renew","db":"test-wa-repo-queue.db","visibility":"3","maxAttempts":"2","port":"","token":""}' >renew-repo-pull.log 2>&1 &
PULLPID=$!
sleep 5
aux4 queue lease --provider repository --db test-wa-repo-queue.db --name bot_wa_repo_renew --visibility 3 >/dev/null 2>&1
echo "mid-run lease exit=$?"
wait $PULLPID
sleep 1
aux4 mock verify --port 18812 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15558880004"' --body-contains '"SLOW_8 done"' --times 1
rm -f renew-repo-state.db renew-repo-pull.log
rm -rf renew-repo-tmp
```

```expect:partial
mid-run lease exit=4**verify ok: 1 match(es)*
```

### push mode: a failing push to /bot/work is retried by the queue's webhook until it succeeds

`POST /bot/work` is provider-agnostic -- the retry guarantee comes from a
`memory`-storage work queue's `--webhook` proxy (lease/ack/nack on the push
itself), proven here alongside the `repository` provider's own main pipeline
via a small dedicated memory queue server on its own port.

```execute
nohup aux4 queue start --provider memory --port 18813 >queue-repo-push.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18813/
aux4 queue create --provider memory --port 18813 --name bot.wa.repo.push --workQueue true --maxAttempts 3 --webhook http://localhost:18810/api/bot/work >/dev/null
rm -f .echobot-marker-15558880005
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-repo-push-1","chatId":"15558880005","text":"FAIL_ONCE hi"}}' | aux4 queue send --provider memory --port 18813 --name bot.wa.repo.push --group 15558880005 >/dev/null
sleep 3
aux4 mock verify --port 18812 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15558880005"' --body-contains '"FAIL_ONCE hi"' --times 1
rm -f .echobot-marker-15558880005
aux4 queue stop --provider memory --port 18813 2>/dev/null
```

```expect:partial
verify ok: 1 match(es)*
```

### a worker killed while the brain is running never replies twice, and the restarted worker finishes the job

This subsection restarts the api server and worker with a shorter queue
`visibility` (`3` instead of `30`) so a crash/resume cycle fits in a
reasonable test time; it is the last scenario in this provider section.

```file:config.yaml
config:
  port: 18810
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-repo-state.db"
    tmpDir: "test-wa-repo-tmp"
    dedupeTtl: 129600
    queue:
      provider: "repository"
      name: "bot.wa.repo.test"
      db: "test-wa-repo-queue.db"
      visibility: "3"
      maxAttempts: "5"
      port: ""
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 20000
      failureMessage: "Sorry, something went wrong processing your message."
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18812/api"
        command: "node echobot.js"
```

```file:wa-repo-crash1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15558880006","id":"wamid.REPOCRASH1","timestamp":"1699999999","type":"text","text":{"body":"SLOW_8 done"}}]}}]}]}
```

```timeout
45000
```

```execute
aux4 api stop --port 18810 2>/dev/null
sleep 1
nohup aux4 api start --configFile config.yaml >api-repo-crash.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18810/
nohup aux4 bot worker --configFile config.yaml --config bot >worker-repo-crash1.log 2>&1 &
WORKER1PID=$!
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-repo-crash1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18810/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-repo-crash1.json
for ROUND in 1 2 3 4; do
  sleep 1
  ALL="$WORKER1PID"
  for i in 1 2 3 4 5 6; do
    MORE=""
    for P in $ALL; do
      MORE="$MORE $(pgrep -P $P 2>/dev/null)"
    done
    ALL="$ALL $MORE"
  done
  for PID in $ALL; do kill -9 $PID 2>/dev/null; done
done
sleep 1
aux4 mock verify --port 18812 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15558880006"' --body-contains '"SLOW_8 done"' --times 0
echo "replies-before-restart:$?"
nohup aux4 bot worker --configFile config.yaml --config bot >worker-repo-crash2.log 2>&1 &
WORKER2PID=$!
sleep 15
ALL="$WORKER2PID"
for i in 1 2 3 4 5 6; do
  MORE=""
  for P in $ALL; do
    MORE="$MORE $(pgrep -P $P 2>/dev/null)"
  done
  ALL="$ALL $MORE"
done
for PID in $ALL; do kill -9 $PID 2>/dev/null; done
aux4 mock verify --port 18812 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15558880006"' --body-contains '"SLOW_8 done"' --times 1
```

```expect:partial
replies-before-restart:0**verify ok: 1 match(es)*
```

## Provider: sqs

```file:config.yaml
config:
  port: 18820
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-sqs-state.db"
    tmpDir: "test-wa-sqs-tmp"
    dedupeTtl: 129600
    queue:
      provider: "sqs"
      name: "bot-wa-sqs-test"
      db: ""
      visibility: "30"
      maxAttempts: "5"
      port: ""
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      failureMessage: "Sorry, something went wrong processing your message."
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18822/api"
        command: "node echobot.js"
```

```file:echobot.js
import fs from "fs";

async function main() {
  const text = process.argv[process.argv.length - 1] || "";
  const chatId = process.env.AUX4BOT_CHAT_ID || "";

  if (text.startsWith("FAIL_ALWAYS")) {
    process.stderr.write("boom-always\n");
    process.exit(1);
  }

  if (text.startsWith("FAIL_ONCE")) {
    const marker = `.echobot-marker-${chatId}`;
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "1");
      process.stderr.write("boom-once\n");
      process.exit(1);
    }
  }

  if (text.startsWith("SLOW_")) {
    const seconds = Number(text.split("_")[1]) || 5;
    await new Promise(r => setTimeout(r, seconds * 1000));
  }

  process.stdout.write(text);
}

main();
```

```file:wa-sqs-msg1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15557770001","id":"wamid.SQS1","timestamp":"1699999999","type":"text","text":{"body":"hello sqs"}}]}}]}]}
```

```afterAll
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
aux4 queue delete --provider sqs --name bot-wa-sqs-test 2>/dev/null
aux4 queue delete --provider sqs --name bot-wa-sqs-renew 2>/dev/null
aux4 api stop --port 18820 2>/dev/null
aux4 mock stop --port 18822 2>/dev/null
aux4 queue stop --provider memory --port 18823 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "aux4 bot work" 2>/dev/null
pkill -f "aux4 bot pull" 2>/dev/null
rm -f test-wa-sqs-state.db
rm -rf test-wa-sqs-tmp
rm -f .echobot-marker-15557770003 .echobot-marker-15557770005
rm -f renew-sqs-state.db renew-sqs-pull.log
rm -rf renew-sqs-tmp
true
```

### should start the mock, the sqs queue (ElasticMQ), the api server, and the worker

```timeout
30000
```

```execute
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:19781 || (echo "ElasticMQ is not reachable on localhost:19781 -- start it first, see the top of this file" && exit 1)
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
aux4 queue delete --provider sqs --name bot-wa-sqs-test >/dev/null 2>&1
aux4 queue create --provider sqs --name bot-wa-sqs-test --maxAttempts 5 >/dev/null
nohup aux4 mock start --port 18822 >mock-sqs.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18822/
aux4 mock stub --port 18822 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
nohup aux4 api start --configFile config.yaml >api-sqs.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18820/
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 nohup aux4 bot worker --configFile config.yaml --config bot >worker-sqs.log 2>&1 &
echo $! > worker-sqs.pid
sleep 1
curl -s "http://localhost:18820/api/whatsapp/support/webhook?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=hs-sqs"
```

```expect
hs-sqs
```

### a signed message gets exactly one reply

```timeout
15000
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-sqs-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18820/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-sqs-msg1.json
sleep 5
aux4 mock verify --port 18822 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15557770001"' --body-contains '"hello sqs"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### redelivering the same event id is not reprocessed

```timeout
15000
```

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-sqs-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18820/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-sqs-msg1.json
sleep 2
aux4 mock verify --port 18822 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15557770001"' --body-contains '"hello sqs"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### two messages to the same chat get replies in the order sent

```timeout
15000
```

```file:wa-sqs-ord1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15557770002","id":"wamid.SQSORD1","timestamp":"1699999999","type":"text","text":{"body":"first message"}}]}}]}]}
```

```file:wa-sqs-ord2.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15557770002","id":"wamid.SQSORD2","timestamp":"1699999999","type":"text","text":{"body":"second message"}}]}}]}]}
```

```execute
SIG1=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-sqs-ord1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18820/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG1" --data-binary @wa-sqs-ord1.json
sleep 0.5
SIG2=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-sqs-ord2.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18820/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG2" --data-binary @wa-sqs-ord2.json
sleep 5
aux4 mock requests --port 18822 --method POST --path /v27.0/PHONE123/messages | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); const toThisChat=r.filter(x=>x.body.includes('15557770002')); console.log(toThisChat.map(x=>x.body.includes('first message')?'first':x.body.includes('second message')?'second':'other').join(','))"
```

```expect
first,second
```

### a brain failure is retried up to maxAttempts, a failureMessage is sent on the final attempt, and the message ends up in the DLQ

```timeout
40000
```

```file:wa-sqs-fail1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15557770003","id":"wamid.SQSFAIL1","timestamp":"1699999999","type":"text","text":{"body":"FAIL_ALWAYS boom"}}]}}]}]}
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
rm -f .echobot-marker-15557770003
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-sqs-fail1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18820/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-sqs-fail1.json
sleep 30
aux4 mock verify --port 18822 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15557770003"' --body-contains 'Sorry, something went wrong' --times 1
aux4 queue dlq --provider sqs --name bot-wa-sqs-test | node -e "const r=require('fs').readFileSync(0,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); console.log(r.filter(m=>m.body.event.key==='wamid.SQSFAIL1').length)"
```

```expect:partial
verify ok: 1 match(es)**1
```

### a long brain under a short visibility is not redelivered, thanks to the renew heartbeat (exactly one reply)

A SEPARATE sqs queue (`bot-wa-sqs-renew`) with a short `visibility`, leased
directly via one `aux4 bot work --mode pull` call -- bypassing the
long-running worker loop above so the timing is fully controlled.

```timeout
35000
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
aux4 queue delete --provider sqs --name bot-wa-sqs-renew >/dev/null 2>&1
aux4 queue create --provider sqs --name bot-wa-sqs-renew --maxAttempts 2 >/dev/null
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-sqs-renew-1","chatId":"15557770004","text":"SLOW_8 done"}}' | aux4 queue send --provider sqs --name bot-wa-sqs-renew --group 15557770004 >/dev/null
nohup aux4 bot work --mode pull --channels '["whatsapp"]' --bots '{"support":{"channel":"whatsapp","phoneNumberId":"PHONE123","verifyToken":"verify-tok","appSecret":"testappsecret","token":"test-access-token","apiUrl":"http://localhost:18822/api","command":"node echobot.js"}}' --defaults '{"failureMessage":"Sorry, something went wrong processing your message."}' --db renew-sqs-state.db --tmpDir renew-sqs-tmp --queue '{"provider":"sqs","name":"bot-wa-sqs-renew","db":"","visibility":"3","maxAttempts":"2","port":"","token":""}' >renew-sqs-pull.log 2>&1 &
PULLPID=$!
sleep 5
aux4 queue lease --provider sqs --name bot-wa-sqs-renew --visibility 3 >/dev/null 2>&1
echo "mid-run lease exit=$?"
wait $PULLPID
sleep 1
aux4 mock verify --port 18822 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15557770004"' --body-contains '"SLOW_8 done"' --times 1
rm -f renew-sqs-state.db renew-sqs-pull.log
rm -rf renew-sqs-tmp
aux4 queue delete --provider sqs --name bot-wa-sqs-renew >/dev/null 2>&1
```

```expect:partial
mid-run lease exit=4**verify ok: 1 match(es)*
```

### push mode: a failing push to /bot/work is retried by the queue's webhook until it succeeds

`POST /bot/work` is provider-agnostic -- the retry guarantee comes from a
`memory`-storage work queue's `--webhook` proxy (lease/ack/nack on the push
itself), proven here alongside the `sqs` provider's own main pipeline via a
small dedicated memory queue server on its own port (no AWS/ElasticMQ
involved in this one).

```execute
nohup aux4 queue start --provider memory --port 18823 >queue-sqs-push.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18823/
aux4 queue create --provider memory --port 18823 --name bot.wa.sqs.push --workQueue true --maxAttempts 3 --webhook http://localhost:18820/api/bot/work >/dev/null
rm -f .echobot-marker-15557770005
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-sqs-push-1","chatId":"15557770005","text":"FAIL_ONCE hi"}}' | aux4 queue send --provider memory --port 18823 --name bot.wa.sqs.push --group 15557770005 >/dev/null
sleep 3
aux4 mock verify --port 18822 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15557770005"' --body-contains '"FAIL_ONCE hi"' --times 1
rm -f .echobot-marker-15557770005
aux4 queue stop --provider memory --port 18823 2>/dev/null
```

```expect:partial
verify ok: 1 match(es)*
```

### a worker killed while the brain is running never replies twice, and the restarted worker finishes the job

This subsection restarts the api server and worker with a shorter queue
`visibility` (`3` instead of `30`) so a crash/resume cycle fits in a
reasonable test time; it is the last scenario in this provider section.

```file:config.yaml
config:
  port: 18820
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-sqs-state.db"
    tmpDir: "test-wa-sqs-tmp"
    dedupeTtl: 129600
    queue:
      provider: "sqs"
      name: "bot-wa-sqs-test"
      db: ""
      visibility: "3"
      maxAttempts: "5"
      port: ""
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 20000
      failureMessage: "Sorry, something went wrong processing your message."
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18822/api"
        command: "node echobot.js"
```

```file:wa-sqs-crash1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15557770006","id":"wamid.SQSCRASH1","timestamp":"1699999999","type":"text","text":{"body":"SLOW_8 done"}}]}}]}]}
```

```timeout
45000
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
aux4 api stop --port 18820 2>/dev/null
sleep 1
nohup aux4 api start --configFile config.yaml >api-sqs-crash.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18820/
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 nohup aux4 bot worker --configFile config.yaml --config bot >worker-sqs-crash1.log 2>&1 &
WORKER1PID=$!
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-sqs-crash1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18820/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-sqs-crash1.json
for ROUND in 1 2 3 4; do
  sleep 1
  ALL="$WORKER1PID"
  for i in 1 2 3 4 5 6; do
    MORE=""
    for P in $ALL; do
      MORE="$MORE $(pgrep -P $P 2>/dev/null)"
    done
    ALL="$ALL $MORE"
  done
  for PID in $ALL; do kill -9 $PID 2>/dev/null; done
done
sleep 1
aux4 mock verify --port 18822 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15557770006"' --body-contains '"SLOW_8 done"' --times 0
echo "replies-before-restart:$?"
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 nohup aux4 bot worker --configFile config.yaml --config bot >worker-sqs-crash2.log 2>&1 &
WORKER2PID=$!
sleep 15
ALL="$WORKER2PID"
for i in 1 2 3 4 5 6; do
  MORE=""
  for P in $ALL; do
    MORE="$MORE $(pgrep -P $P 2>/dev/null)"
  done
  ALL="$ALL $MORE"
done
for PID in $ALL; do kill -9 $PID 2>/dev/null; done
aux4 mock verify --port 18822 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15557770006"' --body-contains '"SLOW_8 done"' --times 1
```

```expect:partial
replies-before-restart:0**verify ok: 1 match(es)*
```

```expect:partial
verify ok: 1 match(es)*
```

## Provider: cloud

```file:config.yaml
config:
  port: 18830
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-cloud-state.db"
    tmpDir: "test-wa-cloud-tmp"
    dedupeTtl: 129600
    queue:
      provider: "cloud"
      name: "bot-wa-cloud-test"
      db: ""
      visibility: "30"
      maxAttempts: "5"
      port: ""
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 5000
      failureMessage: "Sorry, something went wrong processing your message."
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18832/api"
        command: "node echobot.js"
```

```file:echobot.js
import fs from "fs";

async function main() {
  const text = process.argv[process.argv.length - 1] || "";
  const chatId = process.env.AUX4BOT_CHAT_ID || "";

  if (text.startsWith("FAIL_ALWAYS")) {
    process.stderr.write("boom-always\n");
    process.exit(1);
  }

  if (text.startsWith("FAIL_ONCE")) {
    const marker = `.echobot-marker-${chatId}`;
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "1");
      process.stderr.write("boom-once\n");
      process.exit(1);
    }
  }

  if (text.startsWith("SLOW_")) {
    const seconds = Number(text.split("_")[1]) || 5;
    await new Promise(r => setTimeout(r, seconds * 1000));
  }

  process.stdout.write(text);
}

main();
```

```file:wa-cloud-msg1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15556660001","id":"wamid.CLOUD1","timestamp":"1699999999","type":"text","text":{"body":"hello cloud"}}]}}]}]}
```

`aux4/bot`'s fixed queue-config shape (`{name, provider, db, visibility,
maxAttempts, port, token}`) has no `env`/`scope` fields, so the `cloud`
provider's required env/scope can only reach the plugin via
`AUX4_CLOUD_ENV`/`AUX4_CLOUD_SCOPE` in the process environment — exported
before every server/worker/curl step below, not through `config.yaml`.

```afterAll
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
export AUX4_CLOUD_ENV=test
export AUX4_CLOUD_SCOPE=botmeta
aux4 queue delete --provider cloud --name bot-wa-cloud-test 2>/dev/null
aux4 queue delete --provider cloud --name bot-wa-cloud-renew 2>/dev/null
aux4 api stop --port 18830 2>/dev/null
aux4 mock stop --port 18832 2>/dev/null
aux4 queue stop --provider memory --port 18833 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "aux4 bot work" 2>/dev/null
pkill -f "aux4 bot pull" 2>/dev/null
rm -f test-wa-cloud-state.db
rm -rf test-wa-cloud-tmp
rm -f .echobot-marker-15556660003 .echobot-marker-15556660005
rm -f renew-cloud-state.db renew-cloud-pull.log
rm -rf renew-cloud-tmp
true
```

### should start the mock, the cloud queue (ElasticMQ), the api server, and the worker

```timeout
30000
```

```execute
curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:19781 || (echo "ElasticMQ is not reachable on localhost:19781 -- start it first, see the top of this file" && exit 1)
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
export AUX4_CLOUD_ENV=test
export AUX4_CLOUD_SCOPE=botmeta
aux4 queue delete --provider cloud --name bot-wa-cloud-test >/dev/null 2>&1
aux4 queue create --provider cloud --name bot-wa-cloud-test --maxAttempts 5 >/dev/null
nohup aux4 mock start --port 18832 >mock-cloud.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18832/
aux4 mock stub --port 18832 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
AUX4_CLOUD_ENV=test AUX4_CLOUD_SCOPE=botmeta nohup aux4 api start --configFile config.yaml >api-cloud.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18830/
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 AUX4_CLOUD_ENV=test AUX4_CLOUD_SCOPE=botmeta nohup aux4 bot worker --configFile config.yaml --config bot >worker-cloud.log 2>&1 &
echo $! > worker-cloud.pid
sleep 1
curl -s "http://localhost:18830/api/whatsapp/support/webhook?hub.mode=subscribe&hub.verify_token=verify-tok&hub.challenge=hs-cloud"
```

```expect
hs-cloud
```

### a signed message gets exactly one reply

```timeout
15000
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-cloud-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18830/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-cloud-msg1.json
sleep 5
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660001"' --body-contains '"hello cloud"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### redelivering the same event id is not reprocessed

```timeout
15000
```

```execute
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-cloud-msg1.json')).digest('hex'))")
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:18830/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-cloud-msg1.json
sleep 2
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660001"' --body-contains '"hello cloud"' --times 1
```

```expect:partial
200**verify ok: 1 match(es)*
```

### two messages to the same chat get replies in the order sent

```timeout
15000
```

```file:wa-cloud-ord1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15556660002","id":"wamid.CLOUDORD1","timestamp":"1699999999","type":"text","text":{"body":"first message"}}]}}]}]}
```

```file:wa-cloud-ord2.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15556660002","id":"wamid.CLOUDORD2","timestamp":"1699999999","type":"text","text":{"body":"second message"}}]}}]}]}
```

```execute
SIG1=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-cloud-ord1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18830/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG1" --data-binary @wa-cloud-ord1.json
sleep 0.5
SIG2=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-cloud-ord2.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18830/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG2" --data-binary @wa-cloud-ord2.json
sleep 5
aux4 mock requests --port 18832 --method POST --path /v27.0/PHONE123/messages | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); const toThisChat=r.filter(x=>x.body.includes('15556660002')); console.log(toThisChat.map(x=>x.body.includes('first message')?'first':x.body.includes('second message')?'second':'other').join(','))"
```

```expect
first,second
```

### a brain failure is retried up to maxAttempts, a failureMessage is sent on the final attempt, and the message ends up in the DLQ

```timeout
40000
```

```file:wa-cloud-fail1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15556660003","id":"wamid.CLOUDFAIL1","timestamp":"1699999999","type":"text","text":{"body":"FAIL_ALWAYS boom"}}]}}]}]}
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
export AUX4_CLOUD_ENV=test
export AUX4_CLOUD_SCOPE=botmeta
rm -f .echobot-marker-15556660003
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-cloud-fail1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18830/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-cloud-fail1.json
sleep 30
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660003"' --body-contains 'Sorry, something went wrong' --times 1
aux4 queue dlq --provider cloud --name bot-wa-cloud-test | node -e "const r=require('fs').readFileSync(0,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); console.log(r.filter(m=>m.body.event.key==='wamid.CLOUDFAIL1').length)"
```

```expect:partial
verify ok: 1 match(es)**1
```

### a long brain under a short visibility is not redelivered, thanks to the renew heartbeat (exactly one reply)

A SEPARATE cloud queue (`bot-wa-cloud-renew`) with a short `visibility`,
leased directly via one `aux4 bot work --mode pull` call -- bypassing the
long-running worker loop above so the timing is fully controlled.

```timeout
35000
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
export AUX4_CLOUD_ENV=test
export AUX4_CLOUD_SCOPE=botmeta
aux4 queue delete --provider cloud --name bot-wa-cloud-renew >/dev/null 2>&1
aux4 queue create --provider cloud --name bot-wa-cloud-renew --maxAttempts 2 >/dev/null
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-cloud-renew-1","chatId":"15556660004","text":"SLOW_8 done"}}' | aux4 queue send --provider cloud --name bot-wa-cloud-renew --group 15556660004 >/dev/null
nohup aux4 bot work --mode pull --channels '["whatsapp"]' --bots '{"support":{"channel":"whatsapp","phoneNumberId":"PHONE123","verifyToken":"verify-tok","appSecret":"testappsecret","token":"test-access-token","apiUrl":"http://localhost:18832/api","command":"node echobot.js"}}' --defaults '{"failureMessage":"Sorry, something went wrong processing your message."}' --db renew-cloud-state.db --tmpDir renew-cloud-tmp --queue '{"provider":"cloud","name":"bot-wa-cloud-renew","db":"","visibility":"3","maxAttempts":"2","port":"","token":""}' >renew-cloud-pull.log 2>&1 &
PULLPID=$!
sleep 5
aux4 queue lease --provider cloud --name bot-wa-cloud-renew --visibility 3 >/dev/null 2>&1
echo "mid-run lease exit=$?"
wait $PULLPID
sleep 1
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660004"' --body-contains '"SLOW_8 done"' --times 1
rm -f renew-cloud-state.db renew-cloud-pull.log
rm -rf renew-cloud-tmp
aux4 queue delete --provider cloud --name bot-wa-cloud-renew >/dev/null 2>&1
```

```expect:partial
mid-run lease exit=4**verify ok: 1 match(es)*
```

### push mode: a failing push to /bot/work is retried by the queue's webhook until it succeeds

`POST /bot/work` is provider-agnostic -- the retry guarantee comes from a
`memory`-storage work queue's `--webhook` proxy (lease/ack/nack on the push
itself), proven here alongside the `cloud` provider's own main pipeline via
a small dedicated memory queue server on its own port (no AWS/ElasticMQ
involved in this one).

```execute
nohup aux4 queue start --provider memory --port 18833 >queue-cloud-push.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18833/
aux4 queue create --provider memory --port 18833 --name bot.wa.cloud.push --workQueue true --maxAttempts 3 --webhook http://localhost:18830/api/bot/work >/dev/null
rm -f .echobot-marker-15556660005
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-cloud-push-1","chatId":"15556660005","text":"FAIL_ONCE hi"}}' | aux4 queue send --provider memory --port 18833 --name bot.wa.cloud.push --group 15556660005 >/dev/null
sleep 3
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660005"' --body-contains '"FAIL_ONCE hi"' --times 1
rm -f .echobot-marker-15556660005
aux4 queue stop --provider memory --port 18833 2>/dev/null
```

```expect:partial
verify ok: 1 match(es)*
```

### a worker killed while the brain is running never replies twice, and the restarted worker finishes the job

This subsection restarts the api server and worker with a shorter queue
`visibility` (`3` instead of `30`) so a crash/resume cycle fits in a
reasonable test time; it is the last scenario in this provider section.

```file:config.yaml
config:
  port: 18830
  server:
    timeout: 5000
  api:
    "GET /{channel}/{bot}/webhook":
      command: aux4 bot verify --configFile config.yaml --config bot
      public: true
    "POST /{channel}/{bot}/webhook":
      command: aux4 bot ingest --configFile config.yaml --config bot
      public: true
    "POST /bot/work":
      command: aux4 bot work --mode push --configFile config.yaml --config bot
      public: true
  bot:
    channels: ["whatsapp"]
    db: "test-wa-cloud-state.db"
    tmpDir: "test-wa-cloud-tmp"
    dedupeTtl: 129600
    queue:
      provider: "cloud"
      name: "bot-wa-cloud-test"
      db: ""
      visibility: "3"
      maxAttempts: "5"
      port: ""
      token: ""
    defaults:
      threadTtl: 3600
      replyTtl: 3600
      brainTimeout: 20000
      failureMessage: "Sorry, something went wrong processing your message."
    bots:
      support:
        channel: whatsapp
        phoneNumberId: "PHONE123"
        verifyToken: "verify-tok"
        appSecret: "testappsecret"
        token: "test-access-token"
        apiUrl: "http://localhost:18832/api"
        command: "node echobot.js"
```

```file:wa-cloud-crash1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15556660006","id":"wamid.CLOUDCRASH1","timestamp":"1699999999","type":"text","text":{"body":"SLOW_8 done"}}]}}]}]}
```

```timeout
45000
```

```execute
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
export AUX4_CLOUD_ENV=test
export AUX4_CLOUD_SCOPE=botmeta
aux4 api stop --port 18830 2>/dev/null
sleep 1
AUX4_CLOUD_ENV=test AUX4_CLOUD_SCOPE=botmeta nohup aux4 api start --configFile config.yaml >api-cloud-crash.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18830/
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 AUX4_CLOUD_ENV=test AUX4_CLOUD_SCOPE=botmeta nohup aux4 bot worker --configFile config.yaml --config bot >worker-cloud-crash1.log 2>&1 &
WORKER1PID=$!
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','testappsecret').update(require('fs').readFileSync('wa-cloud-crash1.json')).digest('hex'))")
curl -s -o /dev/null -X POST "http://localhost:18830/api/whatsapp/support/webhook" -H "Content-Type: application/json" -H "x-hub-signature-256: sha256=$SIG" --data-binary @wa-cloud-crash1.json
for ROUND in 1 2 3 4; do
  sleep 1
  ALL="$WORKER1PID"
  for i in 1 2 3 4 5 6; do
    MORE=""
    for P in $ALL; do
      MORE="$MORE $(pgrep -P $P 2>/dev/null)"
    done
    ALL="$ALL $MORE"
  done
  for PID in $ALL; do kill -9 $PID 2>/dev/null; done
done
sleep 1
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660006"' --body-contains '"SLOW_8 done"' --times 0
echo "replies-before-restart:$?"
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 AUX4_CLOUD_ENV=test AUX4_CLOUD_SCOPE=botmeta nohup aux4 bot worker --configFile config.yaml --config bot >worker-cloud-crash2.log 2>&1 &
WORKER2PID=$!
sleep 15
ALL="$WORKER2PID"
for i in 1 2 3 4 5 6; do
  MORE=""
  for P in $ALL; do
    MORE="$MORE $(pgrep -P $P 2>/dev/null)"
  done
  ALL="$ALL $MORE"
done
for PID in $ALL; do kill -9 $PID 2>/dev/null; done
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660006"' --body-contains '"SLOW_8 done"' --times 1
```

```expect:partial
replies-before-restart:0**verify ok: 1 match(es)*
```
