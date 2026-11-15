# aux4 bot whatsapp, end-to-end against a mock Graph API, via the cloud queue provider (dev only)

Split out of `bot__whatsapp-e2e-providers.test.md` (BOT-018): the SAME
WhatsApp pipeline as that file (mock Graph API -> `aux4 api` -> `aux4 bot
ingest` -> `aux4 queue` -> `aux4 bot worker` -> bot-meta `send` -> the mock
records the reply), run against the `cloud` `aux4/queue` provider
(`aux4/cloud-queue`, ElasticMQ, via its env+scope naming) only. Covers:

1. a signed message gets exactly one reply,
2. redelivering the same event id is not reprocessed,
3. two messages sent to the same chat get replies in the order sent,
4. a brain failure is retried up to maxAttempts, a failureMessage is sent on
   the final attempt, and the message ends up in the DLQ,
5. a long brain under a short visibility is not redelivered, thanks to the
   renew heartbeat,
6. push mode: a failing push to `/bot/work` is retried by the queue's webhook
   until it succeeds, and
7. a worker killed while the brain is running never replies twice, and the
   restarted worker finishes the job.

**This file is dev-only.** `aux4/cloud-queue` stays off the prod hub until
launch (2026-11-15 decision), so `main`'s CI never installs it and never runs
this file -- only `dev`'s CI does, via a dedicated `test-linux-providers-cloud`
job gated on `github.ref_name == 'dev'`. `memory`/`repository`/`sqs` provider
coverage lives in `bot__whatsapp-e2e-providers.test.md` and runs on both
branches.

Requires `aux4/queue-sqs` and `aux4/cloud-queue` installed (the CI workflow's
`packages:` input does this; `aux4/cloud-queue` delegates its queue
primitives to `aux4/queue-sqs`) and an ElasticMQ server reachable at
`http://localhost:19781` (started as a job-level `services:` container in CI;
locally, start it yourself first):

```bash
docker run -d --name bot-meta-test-elasticmq -p 19781:9324 softwaremill/elasticmq-native
```

## Provider: cloud

```timeout
60000
```

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
35000
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
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  COUNT=$(aux4 mock requests --port 18832 --method POST --path /v27.0/PHONE123/messages | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(r.filter(x=>x.body.includes('15556660002')).length)")
  [ "$COUNT" -ge 2 ] && break
  sleep 1
done
aux4 mock requests --port 18832 --method POST --path /v27.0/PHONE123/messages | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); const toThisChat=r.filter(x=>x.body.includes('15556660002')); console.log(toThisChat.map(x=>x.body.includes('first message')?'first':x.body.includes('second message')?'second':'other').join(','))"
```

```expect
first,second
```

### a brain failure is retried up to maxAttempts, a failureMessage is sent on the final attempt, and the message ends up in the DLQ

```timeout
70000
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
DLQCOUNT=0
for i in $(seq 1 55); do
  aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660003"' --body-contains 'Sorry, something went wrong' --times 1 >/dev/null 2>&1
  REPLY_OK=$?
  DLQCOUNT=$(aux4 queue dlq --provider cloud --name bot-wa-cloud-test | node -e "const r=require('fs').readFileSync(0,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); console.log(r.filter(m=>m.body.event.key==='wamid.CLOUDFAIL1').length)")
  if [ "$REPLY_OK" -eq 0 ] && [ "$DLQCOUNT" = "1" ]; then
    break
  fi
  sleep 1
done
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660003"' --body-contains 'Sorry, something went wrong' --times 1
echo "$DLQCOUNT"
```

```expect:partial
verify ok: 1 match(es)**1
```

### a long brain under a short visibility is not redelivered, thanks to the renew heartbeat (exactly one reply)

A SEPARATE cloud queue (`bot-wa-cloud-renew`) with a short `visibility`,
leased directly via one `aux4 bot work --mode pull` call -- bypassing the
long-running worker loop above so the timing is fully controlled.

```timeout
60000
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
echo '{"channel":"whatsapp","botId":"support","event":{"key":"evt-cloud-renew-1","chatId":"15556660004","text":"SLOW_25 done"}}' | aux4 queue send --provider cloud --name bot-wa-cloud-renew --group 15556660004 >/dev/null
nohup aux4 bot work --mode pull --channels '["whatsapp"]' --bots '{"support":{"channel":"whatsapp","phoneNumberId":"PHONE123","verifyToken":"verify-tok","appSecret":"testappsecret","token":"test-access-token","apiUrl":"http://localhost:18832/api","command":"node echobot.js"}}' --defaults '{"failureMessage":"Sorry, something went wrong processing your message."}' --db renew-cloud-state.db --tmpDir renew-cloud-tmp --queue '{"provider":"cloud","name":"bot-wa-cloud-renew","db":"","visibility":"10","maxAttempts":"2","port":"","token":""}' >renew-cloud-pull.log 2>&1 &
PULLPID=$!
sleep 12
aux4 queue lease --provider cloud --name bot-wa-cloud-renew --visibility 10 >/dev/null 2>&1
echo "mid-run lease exit=$?"
wait $PULLPID
sleep 1
aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660004"' --body-contains '"SLOW_25 done"' --times 1
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
nohup aux4 queue start --provider memory --port 18833 >cloud-queue-push.log 2>&1 &
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
`visibility` (`10` instead of `30`) so a crash/resume cycle fits in a
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
      visibility: "10"
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
75000
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
for i in $(seq 1 45); do
  aux4 mock verify --port 18832 --method POST --path /v27.0/PHONE123/messages --body-contains '"to":"15556660006"' --body-contains '"SLOW_8 done"' --times 1 >/dev/null 2>&1 && break
  sleep 1
done
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
