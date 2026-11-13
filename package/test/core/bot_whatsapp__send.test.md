# aux4 bot whatsapp send

The WhatsApp plugin's `send` command, called by `bot worker`'s best-effort
reply path and by `aux4 bot send` (an ad hoc message). Splits text over
WhatsApp's 4096-char limit into multiple sequential messages, and refuses
with a clear error — pointing at `send-template` — instead of a bare
failure when Meta's Graph API rejects the send because the 24h free-form
session window has elapsed.

```beforeAll
nohup aux4 mock start --port 18763 >mock-send.log 2>&1 &
curl -s --retry 10 --retry-connrefused --retry-delay 1 -o /dev/null http://localhost:18763/
```

```afterAll
aux4 mock stop --port 18763 2>/dev/null
rm -f mock-send.log bot-send-24h-test.db
true
```

## within the 24h session window

### a normal send succeeds

```execute
aux4 mock stub --port 18763 --method POST --path /v27.0/PHONE123/messages --status 200 --body '{"messaging_product":"whatsapp","contacts":[{"wa_id":"15551234567"}],"messages":[{"id":"wamid.OK1"}]}' >/dev/null
echo '{"chatId":"15551234567","text":"hello there","bot":{"phoneNumberId":"PHONE123","token":"t","apiUrl":"http://localhost:18763/api"}}' | aux4 bot whatsapp send
```

```expect
{"ok":true}
```

## outside the 24h session window

### Meta's 24h-window error (code 131047) is refused with a clear message pointing at send-template, not a bare failure

```execute
aux4 mock stub --port 18763 --method POST --path /v27.0/PHONE123/messages --status 400 --body '{"error":{"message":"(#131047) Message failed to send because more than 24 hours have passed since the customer last replied to this number.","type":"OAuthException","code":131047,"fbtrace_id":"abc"}}' >/dev/null
echo '{"chatId":"15559990000","text":"are you still there?","bot":{"phoneNumberId":"PHONE123","token":"t","apiUrl":"http://localhost:18763/api"}}' | aux4 bot whatsapp send
```

```expect:partial
{"ok":false,"error":"WhatsApp blocked this message: outside the 24h customer session window. Use \"aux4 bot whatsapp send-template\"*
```

### a full `aux4 bot send` through the worker's channel resolution fails loudly on the same refusal

```execute
aux4 bot send support --to 15559990000 --text "are you still there?" --bots '{"support":{"channel":"whatsapp","phoneNumberId":"PHONE123","token":"t","apiUrl":"http://localhost:18763/api"}}' --db bot-send-24h-test.db || true
```

```error:partial
WhatsApp blocked this message: outside the 24h customer session window. Use "aux4 bot whatsapp send-template"*
```
