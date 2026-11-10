import crypto from "crypto";

// Shared Meta webhook transport logic (the `verify` half of the channel
// plugin contract) — the same handshake and signature scheme is used by
// WhatsApp Cloud API, Messenger, and Instagram (all ride Meta's one Graph
// webhook transport), so every Meta channel plugin in this package reuses
// this instead of re-implementing it.

function header(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/**
 * GET verification handshake: Meta sends
 * `?hub.mode=subscribe&hub.challenge=<int>&hub.verify_token=<token>`; the
 * endpoint must echo `hub.challenge` back verbatim when `hub.verify_token`
 * matches the bot's configured `verifyToken`.
 */
export function verifyHandshake(query, bot) {
  const query_ = query || {};
  const mode = query_["hub.mode"];
  const token = query_["hub.verify_token"];
  const challenge = query_["hub.challenge"];

  if (mode !== "subscribe") {
    return { valid: false, statusCode: 400 };
  }
  if (!bot || !bot.verifyToken || token !== bot.verifyToken) {
    return { valid: false, statusCode: 403 };
  }
  return { valid: true, body: challenge };
}

/**
 * POST signature verification: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256
 * (app secret, raw body)>`, computed over the byte-exact raw body and
 * compared in constant time.
 */
export function verifySignature(headers, rawBody, bot) {
  const secret = bot && bot.appSecret;
  if (!secret) {
    return { valid: false, statusCode: 500 };
  }

  const signatureHeader = header(headers, "x-hub-signature-256");
  if (!signatureHeader) {
    return { valid: false, statusCode: 401 };
  }

  const match = /^sha256=([0-9a-f]+)$/i.exec(String(signatureHeader).trim());
  if (!match) {
    return { valid: false, statusCode: 401 };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody || "", "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(match[1].toLowerCase(), "utf8");
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  return { valid, statusCode: valid ? 200 : 401 };
}

/**
 * Full `verify` plugin command: dispatches to the GET handshake or the POST
 * signature check based on `method`.
 */
export function verify({ method, query, headers, rawBody, bot }) {
  if (method === "GET") {
    return verifyHandshake(query, bot);
  }
  return verifySignature(headers, rawBody, bot);
}
