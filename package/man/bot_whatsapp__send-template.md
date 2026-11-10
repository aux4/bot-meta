#### Description

Sends a pre-approved WhatsApp Message Template, for initiating contact or
replying outside WhatsApp's 24-hour free-form session window (the window
`aux4 bot whatsapp`'s regular `send` relies on). This is a standalone
utility — unlike `verify`/`ingest-parse`/`typing`/`download`/`format`/
`send`, it is not part of the core's plugin contract and is never called
by `aux4 bot ingest`/`worker`. Run it directly, or from a scheduled job /
another command, whenever you need to reach a user proactively.

The template itself (its name, language, and the number/order of body
parameters) must already exist and be **approved** in the Meta dashboard
(WhatsApp Manager → Message Templates) before this command will succeed —
Meta rejects a template name it doesn't recognize or a parameter count
mismatch.

`bots` and `defaults` are the same `config.bot.bots` / `config.bot.defaults`
map aux4/bot's core commands read — pass `--configFile`/`--config` the same
way, and this command resolves `botId`'s merged config (phoneNumberId,
token, apiUrl override, …) from it directly, with no webhook/queue/worker
involved.

#### Usage

```bash
aux4 bot whatsapp send-template <botId> --to <phone> --template <name> [--languageCode <code>] [--params <json-array>] --configFile <file> --config bot
```

--to            Recipient phone number (E.164, no leading `+`)
--template      Approved template name
--languageCode  Template language/locale code (default: `en_US`)
--params        Body parameter values, as a JSON array of strings (default: `[]`)

#### Example

```bash
aux4 bot whatsapp send-template support \
  --to 15551234567 \
  --template order_shipped \
  --languageCode en_US \
  --params '["Order #4821", "2026-11-12"]' \
  --configFile config.yaml --config bot
```

```json
{"messaging_product":"whatsapp","contacts":[{"input":"15551234567","wa_id":"15551234567"}],"messages":[{"id":"wamid.HBgLMTU1NTEyMzQ1NjcVAgARGBI="}]}
```
