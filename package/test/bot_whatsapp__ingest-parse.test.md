# aux4 bot whatsapp ingest-parse

Parses a WhatsApp Graph API webhook payload into aux4/bot's normalized event
shape. Called directly here with the same stdin JSON shape `aux4 bot ingest`
hands the plugin (`{headers, query, rawBody, bot}`).

## messages

```file:wa-single.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"PHONE123"},"messages":[{"from":"15551230001","id":"wamid.ABC1","timestamp":"1699999999","type":"text","text":{"body":"hello whatsapp"}}]}}]}]}
```

### a text message becomes a normalized message event

```execute
node -e "console.log(JSON.stringify({bot:{},rawBody:require('fs').readFileSync('wa-single.json','utf8')}))" | aux4 bot whatsapp ingest-parse
```

```expect:json
[
  {
    "key": "wamid.ABC1",
    "kind": "message",
    "chatId": "15551230001",
    "userId": "15551230001",
    "text": "hello whatsapp",
    "files": [],
    "ttl": 129600
  }
]
```

### a bot-level dedupeTtl override is honored

```execute
node -e "console.log(JSON.stringify({bot:{dedupeTtl:60},rawBody:require('fs').readFileSync('wa-single.json','utf8')}))" | aux4 bot whatsapp ingest-parse
```

```expect:json
[
  {
    "key": "wamid.ABC1",
    "kind": "message",
    "chatId": "15551230001",
    "userId": "15551230001",
    "text": "hello whatsapp",
    "files": [],
    "ttl": 60
  }
]
```

### a media message carries a file descriptor with the Graph media id

```file:wa-media.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"PHONE123"},"messages":[{"from":"15551230002","id":"wamid.IMG1","timestamp":"1699999999","type":"image","image":{"id":"MEDIAXYZ","mime_type":"image/jpeg","caption":"look at this"}}]}}]}]}
```

```execute
node -e "console.log(JSON.stringify({bot:{},rawBody:require('fs').readFileSync('wa-media.json','utf8')}))" | aux4 bot whatsapp ingest-parse
```

```expect:json
[
  {
    "key": "wamid.IMG1",
    "kind": "message",
    "chatId": "15551230002",
    "userId": "15551230002",
    "text": "",
    "files": [
      {
        "id": "MEDIAXYZ",
        "type": "image",
        "mimeType": "image/jpeg",
        "caption": "look at this"
      }
    ],
    "ttl": 129600
  }
]
```

### a batch of 2 messages in one payload produces 2 events

```file:wa-batch.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"PHONE123"},"messages":[{"from":"15551230011","id":"wamid.B1","timestamp":"1699999999","type":"text","text":{"body":"one"}},{"from":"15551230012","id":"wamid.B2","timestamp":"1699999999","type":"text","text":{"body":"two"}}]}}]}]}
```

```execute
node -e "console.log(JSON.stringify({bot:{},rawBody:require('fs').readFileSync('wa-batch.json','utf8')}))" | aux4 bot whatsapp ingest-parse
```

```expect:json
[
  {
    "key": "wamid.B1",
    "kind": "message",
    "chatId": "15551230011",
    "userId": "15551230011",
    "text": "one",
    "files": [],
    "ttl": 129600
  },
  {
    "key": "wamid.B2",
    "kind": "message",
    "chatId": "15551230012",
    "userId": "15551230012",
    "text": "two",
    "files": [],
    "ttl": 129600
  }
]
```

## statuses

### a status-only payload (no messages) produces zero events

```file:wa-status-only.json
{"object":"whatsapp_business_account","entry":[{"id":"WABA1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"PHONE123"},"statuses":[{"id":"wamid.ABC1","status":"delivered","timestamp":"1699999999","recipient_id":"15551230001"}]}}]}]}
```

```execute
node -e "console.log(JSON.stringify({bot:{},rawBody:require('fs').readFileSync('wa-status-only.json','utf8')}))" | aux4 bot whatsapp ingest-parse
```

```expect:json
[]
```

### an unparseable raw body produces zero events rather than erroring

```execute
node -e "console.log(JSON.stringify({bot:{},rawBody:'not json'}))" | aux4 bot whatsapp ingest-parse
```

```expect:json
[]
```
