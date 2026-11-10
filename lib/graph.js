// Thin wrapper around Meta's Graph API, shared by every Meta channel plugin
// (WhatsApp today; Messenger/Instagram later reuse this unchanged).
//
// The base URL and API version are overridable per-bot (`bot.apiUrl` /
// `bot.apiVersion`) or via environment variables (`WHATSAPP_API_URL` /
// `WHATSAPP_API_VERSION`) so tests can point at a local mock Graph API
// instead of https://graph.facebook.com.

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v27.0";

// Default cap on a single media download, overridable per-bot via
// bot.maxMediaBytes. The inbound media id is only reachable once a
// signature-verified webhook has named it, so this guards against runaway
// memory use (a legitimately huge/misreported file), not an untrusted actor.
export const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024; // 25 MB

/** Build the versioned Graph API base, e.g. "https://graph.facebook.com/v27.0". */
export function apiBase(bot = {}) {
  const base = bot.apiUrl || process.env.WHATSAPP_API_URL || DEFAULT_BASE_URL;
  const version = bot.apiVersion || process.env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION;
  return `${String(base).replace(/\/+$/, "")}/${version}`;
}

/** POST a JSON body to a Graph API path, Bearer-authenticated with bot.token. */
export async function graphPost(bot, path, body) {
  const url = `${apiBase(bot)}/${String(path).replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bot.token || ""}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `Graph API ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** GET a Graph API path, Bearer-authenticated with bot.token. */
export async function graphGet(bot, path) {
  const url = `${apiBase(bot)}/${String(path).replace(/^\/+/, "")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bot.token || ""}` }
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || `Graph API ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/**
 * GET an arbitrary (possibly non-Graph, e.g. a CDN) URL, Bearer-authenticated,
 * returning a Buffer. Enforces a byte cap (`bot.maxMediaBytes`, default
 * `DEFAULT_MAX_MEDIA_BYTES`) — checked against `Content-Length` up front when
 * present, and against the running total while streaming otherwise (or when
 * the server lies about `Content-Length`), aborting the download the moment
 * the cap is exceeded rather than buffering the whole body first.
 */
export async function fetchBinary(bot, url) {
  const maxBytes = bot.maxMediaBytes !== undefined && bot.maxMediaBytes !== "" ? Number(bot.maxMediaBytes) : DEFAULT_MAX_MEDIA_BYTES;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${bot.token || ""}` }
  });
  if (!res.ok) {
    const err = new Error(`download failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const contentLength = Number(res.headers.get("content-length") || 0);
  if (maxBytes > 0 && contentLength > maxBytes) {
    if (res.body && typeof res.body.cancel === "function") {
      res.body.cancel().catch(() => {});
    }
    const err = new Error(`download exceeds maxBytes (${contentLength} > ${maxBytes})`);
    err.status = 413;
    throw err;
  }

  if (maxBytes > 0 && res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          const err = new Error(`download exceeds maxBytes (>${maxBytes})`);
          err.status = 413;
          throw err;
        }
        chunks.push(value);
      }
    } finally {
      if (typeof reader.releaseLock === "function") reader.releaseLock();
    }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (maxBytes > 0 && buffer.length > maxBytes) {
    const err = new Error(`download exceeds maxBytes (${buffer.length} > ${maxBytes})`);
    err.status = 413;
    throw err;
  }
  return buffer;
}
