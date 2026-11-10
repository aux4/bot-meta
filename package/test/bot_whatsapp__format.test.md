# aux4 bot whatsapp format

Converts the brain's Markdown answer into WhatsApp's own text markup. Called
directly here with a stdin JSON payload (the same shape `aux4 bot worker`
sends) rather than through the full webhook pipeline.

## Markdown -> WhatsApp markup

### bold converts to a single asterisk

```execute
echo '{"markdown":"this is **bold** text"}' | aux4 bot whatsapp format
```

```expect:json
{
  "text": "this is *bold* text"
}
```

### italic (either marker) converts to a single underscore

```execute
echo '{"markdown":"this is *italic* and this is _also italic_"}' | aux4 bot whatsapp format
```

```expect:json
{
  "text": "this is _italic_ and this is _also italic_"
}
```

### strikethrough converts to a single tilde

```execute
echo '{"markdown":"this is ~~struck~~ text"}' | aux4 bot whatsapp format
```

```expect:json
{
  "text": "this is ~struck~ text"
}
```

### fenced code blocks pass through untouched

```execute
echo '{"markdown":"before ```const x = 1;``` after"}' | aux4 bot whatsapp format
```

```expect:json
{
  "text": "before ```const x = 1;``` after"
}
```

### bold and italic together do not collide

```execute
echo '{"markdown":"**bold** and *italic* together"}' | aux4 bot whatsapp format
```

```expect:json
{
  "text": "*bold* and _italic_ together"
}
```

### empty/missing markdown returns empty text

```execute
echo '{}' | aux4 bot whatsapp format
```

```expect:json
{
  "text": ""
}
```
