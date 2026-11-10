# aux4 bot whatsapp verify

Signature/handshake verification, called directly with the same stdin JSON
shape `aux4 bot verify`/`aux4 bot ingest` hand the plugin.

## GET handshake

### a matching verify token echoes the challenge back

```execute
echo '{"method":"GET","query":{"hub.mode":"subscribe","hub.verify_token":"tok1","hub.challenge":"999"},"bot":{"verifyToken":"tok1"}}' | aux4 bot whatsapp verify
```

```expect:json
{
  "valid": true,
  "body": "999"
}
```

### a mismatched verify token is rejected with 403

```execute
echo '{"method":"GET","query":{"hub.mode":"subscribe","hub.verify_token":"wrong","hub.challenge":"999"},"bot":{"verifyToken":"tok1"}}' | aux4 bot whatsapp verify
```

```expect:json
{
  "valid": false,
  "statusCode": 403
}
```

### a mode other than subscribe is rejected with 400

```execute
echo '{"method":"GET","query":{"hub.mode":"unsubscribe","hub.verify_token":"tok1","hub.challenge":"999"},"bot":{"verifyToken":"tok1"}}' | aux4 bot whatsapp verify
```

```expect:json
{
  "valid": false,
  "statusCode": 400
}
```

## POST signature check

### a correctly signed body is valid

```execute
BODY='{"entry":[]}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','secret1').update(process.argv[1]).digest('hex'))" "$BODY")
RAW=$(node -e "console.log(JSON.stringify(process.argv[1]))" "$BODY")
echo "{\"method\":\"POST\",\"headers\":{\"x-hub-signature-256\":\"sha256=$SIG\"},\"rawBody\":$RAW,\"bot\":{\"appSecret\":\"secret1\"}}" | aux4 bot whatsapp verify
```

```expect:json
{
  "valid": true,
  "statusCode": 200
}
```

### a wrong signature is rejected with 401

```execute
BODY='{"entry":[]}'
RAW=$(node -e "console.log(JSON.stringify(process.argv[1]))" "$BODY")
echo "{\"method\":\"POST\",\"headers\":{\"x-hub-signature-256\":\"sha256=deadbeef\"},\"rawBody\":$RAW,\"bot\":{\"appSecret\":\"secret1\"}}" | aux4 bot whatsapp verify
```

```expect:json
{
  "valid": false,
  "statusCode": 401
}
```

### a missing signature header is rejected with 401

```execute
BODY='{"entry":[]}'
RAW=$(node -e "console.log(JSON.stringify(process.argv[1]))" "$BODY")
echo "{\"method\":\"POST\",\"headers\":{},\"rawBody\":$RAW,\"bot\":{\"appSecret\":\"secret1\"}}" | aux4 bot whatsapp verify
```

```expect:json
{
  "valid": false,
  "statusCode": 401
}
```

### a missing appSecret fails closed with 500

```execute
BODY='{"entry":[]}'
RAW=$(node -e "console.log(JSON.stringify(process.argv[1]))" "$BODY")
echo "{\"method\":\"POST\",\"headers\":{\"x-hub-signature-256\":\"sha256=deadbeef\"},\"rawBody\":$RAW,\"bot\":{}}" | aux4 bot whatsapp verify
```

```expect:json
{
  "valid": false,
  "statusCode": 500
}
```
