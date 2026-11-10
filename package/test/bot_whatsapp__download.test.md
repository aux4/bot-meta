# aux4 bot whatsapp download — media byte cap

`download` resolves a media id to a CDN URL (`GET /{media-id}`) then
downloads it (`graph.js`'s `fetchBinary`), which enforces a byte cap
(`bot.maxMediaBytes`, default 25 MB) and aborts the download rather than
buffering an oversized file. `download` catches any error from `fetchBinary`
and returns `{"path":null}` — an over-cap file is simply skipped, never
partially written to disk.

```beforeAll
nohup aux4 mock start --port 18762 >mock-dl.log 2>&1 &
sleep 1
aux4 mock stub --port 18762 --method GET --path /v27.0/MEDIA_OK --status 200 --body '{"url":"http://localhost:18762/api/cdn/MEDIA_OK.bin","mime_type":"application/octet-stream"}' >/dev/null
aux4 mock stub --port 18762 --method GET --path /cdn/MEDIA_OK.bin --status 200 --contentType application/octet-stream --body "short" >/dev/null
aux4 mock stub --port 18762 --method GET --path /v27.0/MEDIA_BIG --status 200 --body '{"url":"http://localhost:18762/api/cdn/MEDIA_BIG.bin","mime_type":"application/octet-stream"}' >/dev/null
aux4 mock stub --port 18762 --method GET --path /cdn/MEDIA_BIG.bin --status 200 --contentType application/octet-stream --body "this body is deliberately longer than the configured ten byte cap" >/dev/null
```

```afterAll
aux4 mock stop --port 18762 2>/dev/null
rm -rf dl-tmp
rm -f mock-dl.log
true
```

## within the configured cap

### a media file smaller than maxMediaBytes downloads normally

```execute
node -e "console.log(JSON.stringify({file:{id:'MEDIA_OK'},bot:{apiUrl:'http://localhost:18762/api',apiVersion:'v27.0',token:'tok',maxMediaBytes:1024},tmpDir:'dl-tmp'}))" | aux4 bot whatsapp download
cat dl-tmp/MEDIA_OK 2>/dev/null
```

```expect:partial
{"path":"dl-tmp/MEDIA_OK"}*short*
```

## over the configured cap

### a media file larger than maxMediaBytes is aborted and never written to disk

```execute
node -e "console.log(JSON.stringify({file:{id:'MEDIA_BIG'},bot:{apiUrl:'http://localhost:18762/api',apiVersion:'v27.0',token:'tok',maxMediaBytes:10},tmpDir:'dl-tmp'}))" | aux4 bot whatsapp download
ls dl-tmp/MEDIA_BIG 2>/dev/null || echo "not-written"
```

```expect:partial
{"path":null}*not-written*
```

### the default cap (no maxMediaBytes configured) allows a small file through

```execute
node -e "console.log(JSON.stringify({file:{id:'MEDIA_OK'},bot:{apiUrl:'http://localhost:18762/api',apiVersion:'v27.0',token:'tok'},tmpDir:'dl-tmp'}))" | aux4 bot whatsapp download
```

```expect
{"path":"dl-tmp/MEDIA_OK"}
```
