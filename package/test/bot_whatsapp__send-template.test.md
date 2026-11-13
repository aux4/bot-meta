# aux4 bot whatsapp send-template

Sends a pre-approved WhatsApp Message Template, for replying outside the
24h free-form session window. Standalone utility — not part of the
verify/ingest-parse/typing/download/format/send plugin contract, and not
invoked by `aux4 bot ingest`/`worker`.

```file:bots.json
{
  "support": {
    "channel": "whatsapp",
    "phoneNumberId": "PHONE123",
    "token": "test-access-token",
    "apiUrl": "http://localhost:18764/api"
  }
}
```

```beforeAll
nohup aux4 mock start --port 18764 >mock-template.log 2>&1 &
sleep 1
aux4 mock stub --port 18764 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"15551234567"}],"messages":[{"id":"wamid.TEMPLATESENT"}]}' >/dev/null
```

```afterAll
aux4 mock stop --port 18764 2>/dev/null
rm -f mock-template.log
true
```

## sending a template

### a known bot sends a template with body parameters

```execute
aux4 bot whatsapp send-template support --bots "$(cat bots.json)" --to 15551234567 --template order_shipped --languageCode en_US --params '["Order #4821","2026-11-12"]'
```

```expect:json
{
  "messaging_product": "whatsapp",
  "contacts": [
    {
      "wa_id": "15551234567"
    }
  ],
  "messages": [
    {
      "id": "wamid.TEMPLATESENT"
    }
  ]
}
```

### the mock recorded the template request with its components

```execute
aux4 mock verify --port 18764 --method POST --path /v27.0/PHONE123/messages --body-contains '"name":"order_shipped"' --body-contains '"code":"en_US"' --body-contains 'Order #4821'
```

```expect:partial
verify ok:*
```

### an unknown bot id fails instead of silently sending as someone else

```execute
aux4 bot whatsapp send-template ghost --bots "$(cat bots.json)" --to 15551234567 --template order_shipped || true
```

```error:partial
Unknown bot id: ghost*
```
