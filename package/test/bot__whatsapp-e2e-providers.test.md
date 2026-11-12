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
process.stdout.write(process.argv[process.argv.length - 1]);
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
true
```

### should start the mock, the memory queue, the api server, and the worker

```execute
nohup aux4 mock start --port 18802 >mock-mem.log 2>&1 &
sleep 1
aux4 mock stub --port 18802 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
nohup aux4 queue start --provider memory --port 18801 >queue-mem.log 2>&1 &
sleep 1
aux4 queue create --provider memory --port 18801 --name bot.wa.mem.test --workQueue true --maxAttempts 5 >/dev/null
nohup aux4 api start --configFile config.yaml >api-mem.log 2>&1 &
sleep 1
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
process.stdout.write(process.argv[process.argv.length - 1]);
```

```file:wa-repo-msg1.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"PHONE123"},"messages":[{"from":"15558880001","id":"wamid.REPO1","timestamp":"1699999999","type":"text","text":{"body":"hello repository"}}]}}]}]}
```

```afterAll
aux4 api stop --port 18810 2>/dev/null
aux4 mock stop --port 18812 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "aux4 bot work" 2>/dev/null
pkill -f "aux4 bot pull" 2>/dev/null
rm -f test-wa-repo-state.db test-wa-repo-queue.db
rm -rf test-wa-repo-tmp
true
```

### should start the mock, the repository queue, the api server, and the worker

```execute
rm -f test-wa-repo-queue.db
aux4 queue create --provider repository --db test-wa-repo-queue.db --name bot.wa.repo.test --maxAttempts 5 >/dev/null
nohup aux4 mock start --port 18812 >mock-repo.log 2>&1 &
sleep 1
aux4 mock stub --port 18812 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
nohup aux4 api start --configFile config.yaml >api-repo.log 2>&1 &
sleep 1
nohup aux4 bot worker --configFile config.yaml --config bot >worker-repo.log 2>&1 &
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
process.stdout.write(process.argv[process.argv.length - 1]);
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
aux4 api stop --port 18820 2>/dev/null
aux4 mock stop --port 18822 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "aux4 bot work" 2>/dev/null
pkill -f "aux4 bot pull" 2>/dev/null
rm -f test-wa-sqs-state.db
rm -rf test-wa-sqs-tmp
true
```

### should start the mock, the sqs queue (ElasticMQ), the api server, and the worker

```timeout
15000
```

```execute
curl -s -o /dev/null http://localhost:19781 || (echo "ElasticMQ is not reachable on localhost:19781 -- start it first, see the top of this file" && exit 1)
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
aux4 queue delete --provider sqs --name bot-wa-sqs-test >/dev/null 2>&1
aux4 queue create --provider sqs --name bot-wa-sqs-test --maxAttempts 5 >/dev/null
nohup aux4 mock start --port 18822 >mock-sqs.log 2>&1 &
sleep 1
aux4 mock stub --port 18822 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
nohup aux4 api start --configFile config.yaml >api-sqs.log 2>&1 &
sleep 1
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 nohup aux4 bot worker --configFile config.yaml --config bot >worker-sqs.log 2>&1 &
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
process.stdout.write(process.argv[process.argv.length - 1]);
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
aux4 api stop --port 18830 2>/dev/null
aux4 mock stop --port 18832 2>/dev/null
pkill -f "bot-meta.mjs" 2>/dev/null
pkill -f "aux4 bot work" 2>/dev/null
pkill -f "aux4 bot pull" 2>/dev/null
rm -f test-wa-cloud-state.db
rm -rf test-wa-cloud-tmp
true
```

### should start the mock, the cloud queue (ElasticMQ), the api server, and the worker

```timeout
15000
```

```execute
curl -s -o /dev/null http://localhost:19781 || (echo "ElasticMQ is not reachable on localhost:19781 -- start it first, see the top of this file" && exit 1)
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=elasticmq
export AWS_ENDPOINT_URL=http://localhost:19781
export AUX4_CLOUD_ENV=test
export AUX4_CLOUD_SCOPE=botmeta
aux4 queue delete --provider cloud --name bot-wa-cloud-test >/dev/null 2>&1
aux4 queue create --provider cloud --name bot-wa-cloud-test --maxAttempts 5 >/dev/null
nohup aux4 mock start --port 18832 >mock-cloud.log 2>&1 &
sleep 1
aux4 mock stub --port 18832 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"x"}],"messages":[{"id":"wamid.MOCKSENT"}]}' >/dev/null
AUX4_CLOUD_ENV=test AUX4_CLOUD_SCOPE=botmeta nohup aux4 api start --configFile config.yaml >api-cloud.log 2>&1 &
sleep 1
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=elasticmq AWS_ENDPOINT_URL=http://localhost:19781 AUX4_CLOUD_ENV=test AUX4_CLOUD_SCOPE=botmeta nohup aux4 bot worker --configFile config.yaml --config bot >worker-cloud.log 2>&1 &
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
