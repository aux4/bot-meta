import fs from "fs";
import path from "path";
import { readStdin, reply } from "./stdin.js";
import { verify as metaVerify } from "./meta.js";
import { graphGet, graphPost, fetchBinary } from "./graph.js";
import { markdownToWhatsApp, splitIntoChunks } from "./markdown.js";
import { resolveBotById } from "./config.js";

// WhatsApp Cloud API channel plugin for aux4/bot. Implements the six-command
// plugin contract (verify, ingest-parse, typing, download, format, send)
// plus a standalone `send-template` utility for replying outside the 24h
// free-form session window. See README "WhatsApp setup".

const MEDIA_TYPES = ["image", "video", "audio", "document", "sticker"];

// How long WhatsApp Cloud API webhook deliveries can keep retrying before
// Meta gives up (~36h) — the inbound dedupe window must comfortably exceed
// that, well past the core's own 300s fallback default.
const DEFAULT_DEDUPE_TTL = 36 * 60 * 60;

const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/3gpp": ".3gp",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/amr": ".amr",
  "application/pdf": ".pdf"
};

function extensionFor(mimeType, name) {
  if (name && path.extname(name)) return path.extname(name);
  if (mimeType && MIME_EXTENSIONS[mimeType]) return MIME_EXTENSIONS[mimeType];
  return "";
}

function normalizeMessage(message, ttl) {
  const text = message.text && message.text.body;
  const files = [];
  for (const type of MEDIA_TYPES) {
    const media = message[type];
    if (media && media.id) {
      files.push({
        id: media.id,
        type,
        mimeType: media.mime_type,
        caption: media.caption,
        name: media.filename
      });
    }
  }
  return {
    key: String(message.id),
    kind: "message",
    chatId: message.from,
    userId: message.from,
    text: text || "",
    files,
    ttl
  };
}

/**
 * verify — GET hub.challenge handshake, or POST X-Hub-Signature-256 check
 * over the byte-exact raw body. Shared logic lives in lib/meta.js.
 */
export async function verify() {
  const input = JSON.parse((await readStdin()) || "{}");
  reply(metaVerify(input));
}

/**
 * ingest-parse — walks `entry[].changes[].value`. Each `messages[]` entry
 * becomes a normalized `message` event (text or media files); `statuses[]`
 * entries (sent/delivered/read/failed receipts) are intentionally NOT
 * normalized into events — they never reach the queue. A single POST can
 * carry multiple entries/changes/messages; all are walked.
 */
export async function ingestParse() {
  const input = JSON.parse((await readStdin()) || "{}");
  const bot = input.bot || {};

  let payload = {};
  try {
    payload = JSON.parse(input.rawBody || "{}");
  } catch {
    payload = {};
  }

  const ttl = bot.dedupeTtl ? Number(bot.dedupeTtl) : DEFAULT_DEDUPE_TTL;
  const events = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change.value || {};
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        events.push(normalizeMessage(message, ttl));
      }
      // value.statuses: delivery/read/failed receipts — skipped by design.
    }
  }

  reply(events);
}

/**
 * typing — WhatsApp has no standalone typing indicator independent of a
 * message; mark the inbound message read and raise the typing indicator in
 * one call: POST {phoneNumberId}/messages {status:"read", message_id,
 * typing_indicator:{type:"text"}}. Best-effort — a failure here must never
 * block the reply.
 */
export async function typing() {
  const input = JSON.parse((await readStdin()) || "{}");
  const { event, bot } = input;
  try {
    await graphPost(bot, `${bot.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: event && event.key,
      typing_indicator: { type: "text" }
    });
  } catch (err) {
    process.stderr.write(`[bot-meta whatsapp] typing failed: ${err.message}\n`);
  }
  reply({ ok: true });
}

/**
 * download — a media id (from ingest-parse) must first be resolved to a
 * time-limited CDN URL (GET /{media-id}), then downloaded from that URL,
 * both calls Bearer-authenticated with the same system-user token.
 */
export async function download() {
  const input = JSON.parse((await readStdin()) || "{}");
  const { file, bot, tmpDir } = input;

  if (!file || !file.id) {
    return reply({ path: null });
  }

  try {
    const meta = await graphGet(bot, file.id);
    const buffer = await fetchBinary(bot, meta.url);
    const dir = tmpDir || ".";
    fs.mkdirSync(dir, { recursive: true });
    const ext = extensionFor(meta.mime_type || file.mimeType, file.name);
    const filePath = path.join(dir, `${file.id}${ext}`);
    fs.writeFileSync(filePath, buffer);
    reply({ path: filePath });
  } catch (err) {
    process.stderr.write(`[bot-meta whatsapp] download failed: ${err.message}\n`);
    reply({ path: null });
  }
}

/** format — Markdown -> WhatsApp markup (bold/italic/strike/code). */
export async function format() {
  const input = JSON.parse((await readStdin()) || "{}");
  reply({ text: markdownToWhatsApp(input.markdown) });
}

// Meta's Graph API error code for "more than 24 hours have passed since the
// customer last replied to this number" (the free-form session window).
// Matched by code first (stable across locales/wording); the message regex
// is a fallback for a mock/sandbox that only sets the message.
const SESSION_WINDOW_ERROR_CODE = 131047;
const SESSION_WINDOW_MESSAGE_RE = /24\s*hours?/i;

function isSessionWindowError(err) {
  const code = err && err.body && err.body.error && err.body.error.code;
  if (code === SESSION_WINDOW_ERROR_CODE) return true;
  return SESSION_WINDOW_MESSAGE_RE.test(String(err && err.message));
}

/**
 * send — splits text exceeding WhatsApp's 4096-char limit into multiple
 * sequential text messages, same chatId. threadId is ignored: WhatsApp has
 * no message-level threading.
 *
 * Refuses with a clear `{ok:false, error}` — never throws — when WhatsApp
 * rejects the send because the 24h free-form session window has elapsed
 * (Graph API error code 131047), pointing at `send-template` instead of
 * just surfacing Meta's own terse error text.
 */
export async function send() {
  const input = JSON.parse((await readStdin()) || "{}");
  const { chatId, text, bot } = input;
  const chunks = splitIntoChunks(text, 4096);

  try {
    for (const chunk of chunks) {
      await graphPost(bot, `${bot.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: chatId,
        type: "text",
        text: { body: chunk }
      });
    }
    reply({ ok: true });
  } catch (err) {
    if (isSessionWindowError(err)) {
      const message =
        'WhatsApp blocked this message: outside the 24h customer session window. Use "aux4 bot whatsapp send-template" to re-engage this chat with a pre-approved template.';
      process.stderr.write(`[bot-meta whatsapp] ${message}\n`);
      reply({ ok: false, error: message });
      return;
    }
    process.stderr.write(`[bot-meta whatsapp] send failed: ${err.message}\n`);
    reply({ ok: false, error: err.message });
  }
}

/**
 * send-template — a standalone utility (not part of the core's plugin
 * contract, never called by `aux4 bot ingest`/`worker`) for sending a
 * pre-approved Message Template outside the 24h free-form session window.
 *
 * args: bots, defaults, botId, to, template, languageCode, params (JSON
 * array of positional body-parameter strings).
 */
export async function sendTemplate(args) {
  const [botsArg, defaultsArg, botId, to, template, languageCode, paramsArg] = args;

  const bot = resolveBotById(botsArg, defaultsArg, botId);
  if (!bot) {
    process.stderr.write(`Unknown bot id: ${botId}\n`);
    process.exitCode = 1;
    return;
  }

  let params = [];
  try {
    params = JSON.parse(paramsArg || "[]");
  } catch {
    params = [];
  }

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: languageCode || "en_US" }
    }
  };
  if (Array.isArray(params) && params.length > 0) {
    body.template.components = [{ type: "body", parameters: params.map(p => ({ type: "text", text: String(p) })) }];
  }

  const result = await graphPost(bot, `${bot.phoneNumberId}/messages`, body);
  process.stdout.write(JSON.stringify(result));
}
